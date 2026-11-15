import { DEFAULT_REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from '../domain/backoff';
import { DomainError, InvalidTransactionError } from '../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { settle } from '../domain/settlement';
import type { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InvalidPayloadError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from './errors';
import { noopLogger, noopMetrics, type Logger, type Metrics } from './observability';
import { computePayloadHash } from './payload-hash';
import type { SubmitWagerCommand } from './parsers';
import type { Clock, IdGenerator, TxContext, UnitOfWork } from './ports';

export interface ExecutionContext {
  correlationId: string;
  causationId?: string;
  /** Present when the entry point is SQS: enables persistent per-message deduplication. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the transaction settled. Absent while PENDING_REFERENCE and for FAILED. */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export type MessageOutcome = { kind: 'DUPLICATE_MESSAGE' } | { kind: 'HANDLED'; result: SubmitResult };

export interface ReprocessOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
}

export interface ProcessorConfig {
  referenceRetry: ReferenceRetryPolicy;
  /** In-process retries for deadlock/serialization failures (they are always safe to redo). */
  maxDeadlockRetries: number;
  /** Lock waits at or above this count as a "lock conflict" in metrics. */
  lockContentionThresholdMs: number;
}

export const DEFAULT_PROCESSOR_CONFIG: ProcessorConfig = {
  referenceRetry: DEFAULT_REFERENCE_RETRY_POLICY,
  maxDeadlockRetries: 3,
  lockContentionThresholdMs: 25,
};

export interface ProcessorDependencies {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  metrics?: Metrics;
  logger?: Logger;
  random?: () => number;
  config?: Partial<ProcessorConfig>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The ONE use case behind both HTTP and SQS.
 *
 * Everything below happens in a SINGLE SQL transaction:
 *   (0) inbox gate          INSERT inbox ... ON CONFLICT DO NOTHING            (SQS only)
 *   (1) idempotency gate    INSERT wager_transaction ... ON CONFLICT DO NOTHING (unique keys in the schema)
 *   (2) concurrency gate    SELECT wallet FOR NO KEY UPDATE                    (per-wallet row lock)
 *   (3) rules + effects     settle() -> wallet UPDATE, ledger INSERT, transaction UPDATE, outbox INSERT(s)
 * Events are only ever written to the outbox here, so nothing is published before the commit.
 */
export class ProcessWagerTransactionUseCase {
  private readonly uow: UnitOfWork;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly random: () => number;
  private readonly config: ProcessorConfig;

  constructor(deps: ProcessorDependencies) {
    this.uow = deps.uow;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.metrics = deps.metrics ?? noopMetrics;
    this.logger = deps.logger ?? noopLogger;
    this.random = deps.random ?? Math.random;
    this.config = { ...DEFAULT_PROCESSOR_CONFIG, ...deps.config };
  }

  /** HTTP entry point. */
  async submit(command: SubmitWagerCommand, ctx: ExecutionContext): Promise<SubmitResult> {
    const outcome = await this.execute(command, ctx);
    if (outcome.kind === 'DUPLICATE_MESSAGE') {
      throw new Error('invariant violated: inbox duplicate outside the message flow');
    }
    return outcome.result;
  }

  /** SQS entry point (ctx.inbox must be set). */
  handleMessage(command: SubmitWagerCommand, ctx: ExecutionContext): Promise<MessageOutcome> {
    return this.execute(command, ctx);
  }

  /**
   * Worker entry point: claims ONE due PENDING_REFERENCE transaction and re-runs the very same settlement.
   * Returns undefined when nothing is due. Safe with any number of concurrent workers (SKIP LOCKED).
   */
  async reprocessNextPendingReference(): Promise<ReprocessOutcome | undefined> {
    let claimedId: string | undefined;
    try {
      const outcome = await this.withRetries(() =>
        this.uow.run(async (db) => {
          claimedId = undefined;
          const transaction = await db.transactions.claimNextDuePendingReference(this.clock.now());
          if (!transaction) return undefined;
          claimedId = transaction.id;
          const result = await this.settleLocked(db, transaction, {
            correlationId: transaction.id,
            causationId: transaction.id,
          });
          return { transactionId: transaction.id, status: result.status } satisfies ReprocessOutcome;
        }),
      );
      if (outcome) {
        if (outcome.status === WagerTransactionStatus.PendingReference) {
          this.metrics.increment('pending_reference_attempts_total', { result: 'still_pending' });
        } else {
          this.metrics.increment('pending_reference_attempts_total', { result: outcome.status.toLowerCase() });
          this.metrics.increment('wager_transactions_total', { status: outcome.status, kind: 'DEFERRED' });
        }
      }
      return outcome;
    } catch (error) {
      if (claimedId !== undefined && isPermanent(error)) {
        await this.markFailed(claimedId, error);
      }
      throw error;
    }
  }

  // ---- internals ---------------------------------------------------------------------------------------

  private async execute(command: SubmitWagerCommand, ctx: ExecutionContext): Promise<MessageOutcome> {
    const payloadHash = computePayloadHash(command);
    const startedAt = performance.now();
    try {
      const outcome = await this.withRetries(() =>
        this.uow.run((db) => this.executeInTransaction(db, command, payloadHash, ctx)),
      );
      this.recordOutcome(outcome, command, ctx, performance.now() - startedAt);
      return outcome;
    } catch (error) {
      if (error instanceof TransientInfrastructureError && error.reason === 'lock_timeout') {
        this.metrics.increment('wallet_lock_conflicts_total', { outcome: 'timeout' });
      }
      throw error;
    }
  }

  private async executeInTransaction(
    db: TxContext,
    command: SubmitWagerCommand,
    payloadHash: string,
    ctx: ExecutionContext,
  ): Promise<MessageOutcome> {
    let inboxMessage: InboxMessage | undefined;

    // (0) Inbox gate: persistent per-message dedup, in the same transaction as the effects.
    if (ctx.inbox) {
      inboxMessage = InboxMessage.receive({
        messageId: ctx.inbox.messageId,
        consumerName: ctx.inbox.consumerName,
        payloadHash,
        receivedAt: this.clock.now(),
      });
      const inserted = await db.inbox.insertIfAbsent(inboxMessage);
      if (inserted === 'EXISTS') {
        const existing = await db.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (existing && existing.payloadHash !== payloadHash) {
          throw new InboxPayloadConflictError(ctx.inbox.messageId);
        }
        if (!existing || !existing.isProcessed()) throw new TransientInfrastructureError('replay_not_visible');
        return { kind: 'DUPLICATE_MESSAGE' };
      }
    }

    const transaction = this.buildTransaction(command, payloadHash);

    // (1) Idempotency gate. The unique indexes make concurrent duplicates wait for the first commit.
    const created = await db.transactions.insertIfAbsent(transaction);

    let result: SubmitResult;
    if (!created) {
      result = await this.replay(db, command, payloadHash);
    } else {
      // (2) + (3)
      result = await this.settleLocked(db, transaction, ctx);
    }

    if (inboxMessage) {
      inboxMessage.markProcessed(this.clock.now());
      await db.inbox.markProcessed(inboxMessage);
    }
    return { kind: 'HANDLED', result };
  }

  private buildTransaction(command: SubmitWagerCommand, payloadHash: string): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof InvalidTransactionError) {
        throw new InvalidPayloadError([{ field: 'transaction', message: error.message }]);
      }
      throw error;
    }
  }

  /** A previously stored transaction: return its ORIGINAL result, or a conflict if the payload differs. */
  private async replay(db: TxContext, command: SubmitWagerCommand, payloadHash: string): Promise<SubmitResult> {
    const rows = await db.transactions.findByKeyOrExternal(
      command.idempotencyKey,
      command.providerId,
      command.externalTransactionId,
    );
    if (rows.length === 0) throw new TransientInfrastructureError('replay_not_visible');

    const byKey = rows.find((row) => row.idempotencyKey === command.idempotencyKey);
    if (!byKey) {
      throw new IdempotencyConflictError('providerId + externalTransactionId already used with another idempotency key');
    }
    if (rows.some((row) => row.id !== byKey.id) || !byKey.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError();
    }
    return this.toResult(byKey, true);
  }

  /** Steps (2) and (3): lock the wallet, decide, and persist every effect. The transaction row already exists. */
  private async settleLocked(db: TxContext, transaction: WagerTransaction, ctx: ExecutionContext): Promise<SubmitResult> {
    const lockStartedAt = performance.now();
    const wallet = await db.wallets.lockById(transaction.walletId);
    const waitedMs = performance.now() - lockStartedAt;
    this.metrics.observe('wallet_lock_wait_seconds', waitedMs / 1000);
    if (waitedMs >= this.config.lockContentionThresholdMs) {
      this.metrics.increment('wallet_lock_conflicts_total', { outcome: 'waited' });
    }
    if (!wallet) throw new WalletNotFoundError(transaction.walletId);

    const expectedVersion = wallet.version;
    const now = this.clock.now();

    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await db.transactions.findByProviderAndExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (reference && transaction.isReversal()) {
        referenceAlreadyReversed = (await db.transactions.findProcessedReversalOf(reference.id)) !== undefined;
      }
    }

    const settlement = settle({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      now,
    });

    switch (settlement.type) {
      case 'WAIT_REFERENCE':
        return this.onWaitingForReference(db, transaction, wallet, settlement.reason, ctx, now);
      case 'REJECTED':
        return this.onRejected(db, transaction, wallet, settlement.code, ctx, now);
      case 'APPLIED':
        return this.onApplied(db, transaction, wallet, expectedVersion, settlement.entry, reference, ctx, now);
    }
  }

  private async onApplied(
    db: TxContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    expectedVersion: number,
    entry: WalletLedgerEntry | undefined,
    reference: WagerTransaction | undefined,
    ctx: ExecutionContext,
    now: Date,
  ): Promise<SubmitResult> {
    transaction.markProcessed(reference?.id, now, wallet.balance);
    await db.transactions.save(transaction);

    if (entry) {
      await db.wallets.save(wallet, expectedVersion);
      await db.ledger.append(entry);
    }

    await this.enqueue(db, WagerTransactionProcessed.from(transaction, this.eventContext(ctx, transaction, now)));
    if (entry) {
      await this.enqueue(db, WalletBalanceChanged.from(wallet, entry, this.eventContext(ctx, transaction, now)));
    }
    await db.transactions.wakePendingReferencing(transaction.providerId, transaction.externalTransactionId, now);
    return this.toResult(transaction, false);
  }

  private async onRejected(
    db: TxContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    ctx: ExecutionContext,
    now: Date,
  ): Promise<SubmitResult> {
    // A rejection is a committed, auditable fact: no wallet change, no ledger entry, but an event.
    transaction.reject(code, now, wallet.balance);
    await db.transactions.save(transaction);
    await this.enqueue(db, WagerTransactionRejected.from(transaction, this.eventContext(ctx, transaction, now)));
    await db.transactions.wakePendingReferencing(transaction.providerId, transaction.externalTransactionId, now);
    return this.toResult(transaction, false);
  }

  private async onWaitingForReference(
    db: TxContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    reason: 'REFERENCE_MISSING' | 'REFERENCE_UNSETTLED',
    ctx: ExecutionContext,
    now: Date,
  ): Promise<SubmitResult> {
    const policy = this.config.referenceRetry;

    if (
      transaction.status === WagerTransactionStatus.PendingReference &&
      transaction.referenceBudgetExhausted(now, policy)
    ) {
      const code = reason === 'REFERENCE_MISSING' ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotSettled;
      return this.onRejected(db, transaction, wallet, code, ctx, now);
    }

    const firstTime = transaction.status === WagerTransactionStatus.Pending;
    transaction.markPendingReference(now, policy, this.random());
    await db.transactions.save(transaction);
    if (firstTime) {
      await this.enqueue(
        db,
        WagerTransactionPendingReference.from(transaction, this.eventContext(ctx, transaction, now)),
      );
    }
    return this.toResult(transaction, false);
  }

  private async enqueue(db: TxContext, event: IntegrationEvent<unknown>): Promise<void> {
    await db.outbox.enqueue(OutboxMessage.enqueue(event));
  }

  private eventContext(ctx: ExecutionContext, transaction: WagerTransaction, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? transaction.id,
      occurredAt: now,
    };
  }

  private toResult(transaction: WagerTransaction, idempotentReplay: boolean): SubmitResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.observedBalance ? { balance: transaction.observedBalance.toJSON() } : {}),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay,
    };
  }

  private recordOutcome(outcome: MessageOutcome, command: SubmitWagerCommand, ctx: ExecutionContext, ms: number): void {
    const source = ctx.inbox ? 'sqs' : 'http';
    if (outcome.kind === 'DUPLICATE_MESSAGE') {
      this.metrics.increment('wager_duplicates_total', { source, type: 'message' });
      return;
    }
    this.metrics.observe('wager_processing_duration_seconds', ms / 1000, { source });
    if (outcome.result.idempotentReplay) {
      this.metrics.increment('wager_duplicates_total', { source, type: 'idempotency' });
    } else {
      this.metrics.increment('wager_transactions_total', { status: outcome.result.status, kind: command.kind });
    }
  }

  private async markFailed(transactionId: string, cause: unknown): Promise<void> {
    try {
      await this.uow.run(async (db) => {
        const transaction = await db.transactions.findById(transactionId, { forUpdate: true });
        if (!transaction || transaction.isTerminal()) return;
        transaction.fail(FailureCode.InternalError, this.clock.now());
        await db.transactions.save(transaction);
      });
      this.metrics.increment('wager_transactions_total', { status: WagerTransactionStatus.Failed, kind: 'DEFERRED' });
      this.logger.error('transaction marked FAILED after permanent error', {
        transactionId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } catch (markError) {
      this.logger.error('could not mark transaction FAILED', {
        transactionId,
        error: markError instanceof Error ? markError.message : String(markError),
      });
    }
  }

  /** Deadlocks and serialization failures are always safe to redo; everything else bubbles up. */
  private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof TransientInfrastructureError &&
          (error.reason === 'deadlock' || error.reason === 'serialization') &&
          attempt <= this.config.maxDeadlockRetries;
        if (!retryable) throw error;
        this.metrics.increment('wager_retries_total', { reason: (error as TransientInfrastructureError).reason });
        await sleep(5 + this.random() * 20 * attempt);
      }
    }
  }
}

function isPermanent(error: unknown): boolean {
  return error instanceof DomainError || error instanceof PermanentInfrastructureError;
}
