import type { MoneyProps } from '../domain/money';
import { WalletNotFoundError } from './errors';
import { noopLogger, noopMetrics, type Logger, type Metrics } from './observability';
import type { UnitOfWork } from './ports';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** True when every entry's balanceBefore equals the previous entry's balanceAfter. */
  chainIntact: boolean;
}

/**
 * Compares the materialised balance with the balance rebuilt from the ledger (and verifies the entry chain).
 * Read-only: divergences are NEVER corrected silently. They are logged, counted in a metric and flagged in the response.
 */
export class ReconcileWalletUseCase {
  private readonly metrics: Metrics;
  private readonly logger: Logger;

  constructor(
    private readonly uow: UnitOfWork,
    deps: { metrics?: Metrics; logger?: Logger } = {},
  ) {
    this.metrics = deps.metrics ?? noopMetrics;
    this.logger = deps.logger ?? noopLogger;
  }

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.uow.run((db) => db.ledger.reconcile(walletId));
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const chainIntact = snapshot.chainBreaks === 0;
    const consistent = difference.isZero() && chainIntact;

    if (!consistent) {
      this.metrics.increment('reconciliation_divergences_total');
      this.logger.error('wallet reconciliation divergence detected', {
        walletId,
        difference: difference.toJSON().amount,
        chainBreaks: snapshot.chainBreaks,
        checkedEntries: snapshot.entries,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
      chainIntact,
    };
  }
}
