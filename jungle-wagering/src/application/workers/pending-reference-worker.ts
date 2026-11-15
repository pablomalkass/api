import { noopLogger, type Logger } from '../observability';
import type { BackgroundWorker } from '../ports';
import type { ProcessWagerTransactionUseCase } from '../process-wager-transaction';
import { PollingLoop } from './polling-loop';

/**
 * Re-processes transactions parked in PENDING_REFERENCE (REFUND/ROLLBACK/WIN/LOSS that arrived before the
 * transaction they reference). Each claimed row runs through the exact same settlement as a fresh request,
 * with exponential backoff and a hard retry/TTL budget (see ReferenceRetryPolicy).
 *
 * Multi-instance safe: the claim uses FOR NO KEY UPDATE SKIP LOCKED, so no leader election is needed.
 */
export class PendingReferenceWorker implements BackgroundWorker {
  private readonly loop: PollingLoop;

  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    options: { idleMs?: number; maxPerTick?: number; logger?: Logger } = {},
  ) {
    const logger = options.logger ?? noopLogger;
    const maxPerTick = options.maxPerTick ?? 50;
    this.loop = new PollingLoop(
      'pending-reference-worker',
      async () => {
        let processed = 0;
        while (processed < maxPerTick) {
          const outcome = await this.useCase.reprocessNextPendingReference();
          if (!outcome) break;
          processed++;
        }
        return processed > 0;
      },
      options.idleMs ?? 1_000,
      logger,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Drains everything currently due. Handy for tests and for operators. */
  async drainOnce(maxPerTick = 1_000): Promise<number> {
    let processed = 0;
    while (processed < maxPerTick) {
      const outcome = await this.useCase.reprocessNextPendingReference();
      if (!outcome) break;
      processed++;
    }
    return processed;
  }
}
