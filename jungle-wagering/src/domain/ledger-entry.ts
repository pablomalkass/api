import { LedgerEntryUnbalancedError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  /** Wallet version produced by this entry. Unique per wallet: links the ledger to the balance history. */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Immutable ledger line. There are no mutable fields and no transition methods:
 * immutability is structural here and enforced again by the database (append-only triggers).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Validates the arithmetic of the entry: balanceBefore ± money === balanceAfter, never negative. */
  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new LedgerEntryUnbalancedError('ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerEntryUnbalancedError('ledger balances must not be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new LedgerEntryUnbalancedError('walletVersion must be a positive integer');
    }
    if (!entry.isBalanced()) {
      throw new LedgerEntryUnbalancedError(
        `unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstruction from persistence: trusts already-persisted state. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
