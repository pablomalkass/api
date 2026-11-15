import { DomainError } from '../../domain/errors';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InvalidPayloadError,
  PermanentInfrastructureError,
  WalletNotFoundError,
} from '../errors';
import { noopLogger, noopMetrics, type Logger, type Metrics } from '../observability';
import { parseQueueEnvelope, type QueueEnvelope } from '../parsers';
import type { BackgroundWorker, QueueClient, QueueMessage } from '../ports';
import type { ProcessWagerTransactionUseCase } from '../process-wager-transaction';

export interface QueueConsumerConfig {
  consumerName: string;
  /**
   * Application-level attempt limit before a message is moved to the DLQ. Keep the queue's own RedrivePolicy
   * maxReceiveCount HIGHER (infra uses 10) so it is only a safety net: in a FIFO group, innocent followers of a
   * failing head message are re-received several times and must not be dead-lettered because of it.
   */
  maxReceiveCount: number;
  batchSize: number;
  waitTimeSeconds: number;
  /** Number of concurrent poll loops. */
  pollers: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
  idleBackoffMs: number;
}

export const DEFAULT_QUEUE_CONSUMER_CONFIG: QueueConsumerConfig = {
  consumerName: 'wager-transactions-consumer',
  maxReceiveCount: 5,
  batchSize: 10,
  waitTimeSeconds: 20,
  pollers: 2,
  retryBaseSeconds: 2,
  retryMaxSeconds: 300,
  shutdownTimeoutMs: 25_000,
  idleBackoffMs: 1_000,
};

export interface ConsumerHooks {
  /** Test seam: runs after the SQL commit and before the ack. Throwing here simulates a crash in that window. */
  afterCommitBeforeAck?: (message: QueueMessage) => Promise<void> | void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQS consumer. Contract:
 *
 *  - reuses the SAME use case as HTTP;
 *  - deduplicates through the persistent inbox, inside the same SQL transaction as the financial effects;
 *  - acks (deletes) ONLY after the commit;
 *  - business outcomes (including REJECTED, which is committed) -> ack;
 *  - transient failures -> no ack, visibility backoff, DLQ after `maxReceiveCount` attempts;
 *  - permanent failures (invalid message, payload conflicts, unknown wallet, integrity errors) -> straight to the DLQ;
 *  - SIGTERM: stop polling, finish in-flight messages, hand untouched ones back (visibility 0).
 */
export class WagerQueueConsumer implements BackgroundWorker {
  private readonly config: QueueConsumerConfig;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private running = false;
  /** True from stop() on: pollers exit and groups hand untouched messages back. Independent of start(), so pollOnce() works alone. */
  private stopping = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly deps: {
      queue: QueueClient;
      deadLetterQueue: QueueClient;
      useCase: ProcessWagerTransactionUseCase;
      metrics?: Metrics;
      logger?: Logger;
      config?: Partial<QueueConsumerConfig>;
      hooks?: ConsumerHooks;
    },
  ) {
    this.config = { ...DEFAULT_QUEUE_CONSUMER_CONFIG, ...deps.config };
    this.metrics = deps.metrics ?? noopMetrics;
    this.logger = deps.logger ?? noopLogger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.abort = new AbortController();
    this.loops = Array.from({ length: this.config.pollers }, () => this.run());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.config.shutdownTimeoutMs);
    });
    await Promise.race([Promise.allSettled(this.loops), timeout]);
    if (timer) clearTimeout(timer);
    this.running = false;
  }

  /** Receives and handles one batch. Public so tests can drive the consumer deterministically. */
  async pollOnce(): Promise<number> {
    const messages = await this.deps.queue.receive({
      maxMessages: this.config.batchSize,
      waitTimeSeconds: 0,
    });
    await this.processBatch(messages);
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: QueueMessage[];
      try {
        messages = await this.deps.queue.receive({
          maxMessages: this.config.batchSize,
          waitTimeSeconds: this.config.waitTimeSeconds,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (this.stopping) break;
        this.logger.error('queue receive failed', { error: error instanceof Error ? error.message : String(error) });
        await sleep(this.config.idleBackoffMs);
        continue;
      }
      if (messages.length === 0) {
        if (this.config.waitTimeSeconds === 0) await sleep(this.config.idleBackoffMs);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  /** Groups run concurrently; messages of the same group stay strictly sequential and in order. */
  private async processBatch(messages: QueueMessage[]): Promise<void> {
    const groups = new Map<string, QueueMessage[]>();
    for (const message of messages) {
      const key = message.groupId ?? message.messageId;
      const group = groups.get(key);
      if (group) group.push(message);
      else groups.set(key, [message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: QueueMessage[]): Promise<void> {
    for (let index = 0; index < group.length; index++) {
      const message = group[index] as QueueMessage;
      if (this.stopping) {
        await this.release(group.slice(index));
        return;
      }
      let acked = false;
      try {
        acked = await this.handle(message);
      } catch (error) {
        // Includes the crash-simulation hook: no ack, no visibility change; SQS redelivers after the timeout.
        this.logger.error('message handling aborted', {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!acked) {
        // Preserve in-group order: give back everything behind the message that did not complete.
        await this.release(group.slice(index + 1));
        return;
      }
    }
  }

  /** Resolves true when the message left the queue (acked or dead-lettered). */
  private async handle(message: QueueMessage): Promise<boolean> {
    let envelope: QueueEnvelope;
    try {
      envelope = parseQueueEnvelope(JSON.parse(message.body));
    } catch (error) {
      return this.deadLetter(message, 'INVALID_MESSAGE', error);
    }

    try {
      await this.deps.useCase.handleMessage(envelope.command, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: { consumerName: this.config.consumerName, messageId: envelope.messageId },
      });
    } catch (error) {
      return this.handleFailure(message, envelope, error);
    }

    // The SQL transaction has COMMITTED. Only now may the message be acknowledged.
    await this.deps.hooks?.afterCommitBeforeAck?.(message);
    try {
      await this.deps.queue.delete(message.receiptHandle);
    } catch (error) {
      // Safe: the redelivery will hit the inbox and be acked without any effect.
      this.logger.warn('ack failed after commit; redelivery will be deduplicated by the inbox', {
        messageId: envelope.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.metrics.increment('wager_messages_total', { result: 'acked' });
    return true;
  }

  private async handleFailure(message: QueueMessage, envelope: QueueEnvelope, error: unknown): Promise<boolean> {
    if (isPermanentMessageError(error)) {
      return this.deadLetter(message, permanentReason(error), error);
    }

    this.metrics.increment('wager_retries_total', { reason: 'queue' });
    if (message.receiveCount >= this.config.maxReceiveCount) {
      return this.deadLetter(message, 'MAX_ATTEMPTS_EXCEEDED', error);
    }
    const delay = Math.min(
      this.config.retryMaxSeconds,
      this.config.retryBaseSeconds * 2 ** Math.max(0, message.receiveCount - 1),
    );
    this.logger.warn('transient failure, message will be retried', {
      messageId: envelope.messageId,
      receiveCount: message.receiveCount,
      retryInSeconds: delay,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await this.deps.queue.changeVisibility(message.receiptHandle, delay);
    } catch (visibilityError) {
      this.logger.warn('could not extend visibility; default timeout applies', {
        error: visibilityError instanceof Error ? visibilityError.message : String(visibilityError),
      });
    }
    return false;
  }

  private async deadLetter(message: QueueMessage, reason: string, error: unknown): Promise<boolean> {
    try {
      await this.deps.deadLetterQueue.send(message.body, {
        groupId: message.groupId ?? 'dead-letter',
        deduplicationId: `${message.messageId}:${message.receiveCount}`,
        attributes: { reason },
      });
      await this.deps.queue.delete(message.receiptHandle);
    } catch (sendError) {
      this.logger.error('failed to dead-letter message; it will be retried', {
        messageId: message.messageId,
        reason,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
      return false;
    }
    this.metrics.increment('wager_dlq_messages_total', { reason });
    this.logger.error('message moved to DLQ', {
      messageId: message.messageId,
      reason,
      receiveCount: message.receiveCount,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  private async release(messages: QueueMessage[]): Promise<void> {
    await Promise.allSettled(messages.map((message) => this.deps.queue.changeVisibility(message.receiptHandle, 0)));
  }
}

function isPermanentMessageError(error: unknown): boolean {
  return (
    error instanceof InvalidPayloadError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof WalletNotFoundError ||
    error instanceof PermanentInfrastructureError ||
    error instanceof DomainError
  );
}

function permanentReason(error: unknown): string {
  if (error instanceof InvalidPayloadError) return 'INVALID_MESSAGE';
  if (error instanceof IdempotencyConflictError) return 'IDEMPOTENCY_CONFLICT';
  if (error instanceof InboxPayloadConflictError) return 'INBOX_PAYLOAD_CONFLICT';
  if (error instanceof WalletNotFoundError) return 'WALLET_NOT_FOUND';
  if (error instanceof DomainError) return error.code;
  return 'PERMANENT_ERROR';
}
