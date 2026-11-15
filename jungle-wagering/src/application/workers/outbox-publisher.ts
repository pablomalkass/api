import { noopLogger, noopMetrics, type Logger, type Metrics } from '../observability';
import type { BackgroundWorker, Clock, EventPublisher, UnitOfWork } from '../ports';
import { PollingLoop } from './polling-loop';

export interface OutboxPublisherConfig {
  batchSize: number;
  idleMs: number;
}

/**
 * Publishes committed outbox rows. Safe with any number of concurrent publishers:
 *
 *  - rows are claimed with FOR UPDATE SKIP LOCKED, so two publishers never hold the same row;
 *  - the claim, the publish and the "published" mark share one SQL transaction. If the process dies
 *    anywhere in between, PostgreSQL rolls back, the row locks vanish and another instance takes over;
 *  - that makes delivery AT-LEAST-ONCE: a crash after the broker accepted a message but before the commit
 *    publishes it again. Consumers deduplicate by eventId, and the FIFO queue also dedups by eventId
 *    (MessageDeduplicationId) inside its 5-minute window.
 *
 * Ordering note: with several publishers SKIP LOCKED can interleave rows of the same wallet; consumers
 * order by `walletVersion` inside the event instead of trusting delivery order.
 */
export class OutboxPublisher implements BackgroundWorker {
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly loop: PollingLoop;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      publisher: EventPublisher;
      clock: Clock;
      metrics?: Metrics;
      logger?: Logger;
      config?: Partial<OutboxPublisherConfig>;
    },
  ) {
    this.metrics = deps.metrics ?? noopMetrics;
    this.logger = deps.logger ?? noopLogger;
    const config = { batchSize: 50, idleMs: 500, ...deps.config };
    this.batchSize = config.batchSize;
    this.loop = new PollingLoop('outbox-publisher', async () => (await this.publishBatch()) > 0, config.idleMs, this.logger);
  }

  private readonly batchSize: number;

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Publishes one batch. Returns how many rows were claimed. */
  publishBatch(): Promise<number> {
    return this.deps.uow.run(async (db) => {
      const now = this.deps.clock.now();
      const lag = await db.outbox.lagSeconds(now);
      this.metrics.gauge('outbox_lag_seconds', lag);

      const due = await db.outbox.claimDue(this.batchSize, now);
      for (const message of due) {
        try {
          await this.deps.publisher.publish({
            eventId: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            body: JSON.stringify(message.payload),
          });
          message.markPublished(this.deps.clock.now());
          this.metrics.increment('outbox_published_total', { eventType: message.eventType });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          message.scheduleRetry(this.deps.clock.now(), reason);
          this.metrics.increment('outbox_publish_failures_total', { eventType: message.eventType });
          this.logger.warn('outbox publish failed, retry scheduled', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            error: reason,
          });
        }
        await db.outbox.save(message);
      }
      return due.length;
    });
  }
}
