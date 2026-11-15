import { InvalidTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection, type WalletLedgerEntry } from './ledger-entry';
import type { Wallet } from './wallet';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction';

export type Settlement =
  /** The business operation was applied to the wallet (entry is absent for LOSS). */
  | { type: 'APPLIED'; entry?: WalletLedgerEntry }
  /** A business rule was violated. Wallet is untouched. */
  | { type: 'REJECTED'; code: FailureCode }
  /** The referenced transaction is missing/unsettled; wallet is untouched. */
  | { type: 'WAIT_REFERENCE'; reason: 'REFERENCE_MISSING' | 'REFERENCE_UNSETTLED' };

export interface SettlementInput {
  /** The wallet, already loaded UNDER LOCK by the caller. It is mutated only when the result is APPLIED. */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** The transaction named by referenceExternalTransactionId, if it exists. */
  reference?: WagerTransaction;
  /** True when a PROCESSED REFUND/ROLLBACK already reverted `reference`. */
  referenceAlreadyReversed: boolean;
  entryId: string;
  now: Date;
}

/**
 * Pure business policy for BET / WIN / LOSS / REFUND / ROLLBACK.
 * Returns an outcome instead of throwing: a rejection is a normal, persisted, auditable result,
 * not an exception (an exception inside the SQL transaction would roll the rejection record back).
 */
export function settle(input: SettlementInput): Settlement {
  const { wallet, transaction: tx, reference, now } = input;

  if (tx.kind === WagerTransactionKind.Opening) {
    throw new InvalidTransactionError('OPENING is internal and is never settled through the wagering flow');
  }
  if (wallet.playerId !== tx.playerId) {
    return { type: 'REJECTED', code: FailureCode.WalletPlayerMismatch };
  }
  if (wallet.currency !== tx.money.currency) {
    return { type: 'REJECTED', code: FailureCode.CurrencyMismatch };
  }

  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) return { type: 'WAIT_REFERENCE', reason: 'REFERENCE_MISSING' };
    const evaluation = tx.evaluateReference(reference);
    if (evaluation.type === 'WAIT') return { type: 'WAIT_REFERENCE', reason: 'REFERENCE_UNSETTLED' };
    if (evaluation.type === 'REJECT') return { type: 'REJECTED', code: evaluation.code };
    if (tx.isReversal() && input.referenceAlreadyReversed) {
      return { type: 'REJECTED', code: FailureCode.AlreadyReversed };
    }
  }

  const movement = { entryId: input.entryId, transactionId: tx.id, now };

  switch (tx.kind) {
    case WagerTransactionKind.Loss:
      return { type: 'APPLIED' };

    case WagerTransactionKind.Bet:
      if (!wallet.canDebit(tx.money)) return { type: 'REJECTED', code: FailureCode.InsufficientFunds };
      return { type: 'APPLIED', entry: wallet.debit(tx.money, movement) };

    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return { type: 'APPLIED', entry: wallet.credit(tx.money, movement) };

    case WagerTransactionKind.Rollback: {
      if (tx.ledgerDirectionFor(reference) === LedgerDirection.Credit) {
        return { type: 'APPLIED', entry: wallet.credit(tx.money, movement) };
      }
      // Reverting a WIN/REFUND takes money back. If the player already spent it, reject distinctly.
      if (!wallet.canDebit(tx.money)) return { type: 'REJECTED', code: FailureCode.ReversalWouldOverdraw };
      return { type: 'APPLIED', entry: wallet.debit(tx.money, movement) };
    }
  }
}
