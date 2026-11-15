import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  entryId: string;
  transactionId: string;
  now: Date;
}

/**
 * Aggregate root. The balance is only ever changed through `debit`/`credit`, and each of those
 * returns the matching immutable ledger entry, so balance and ledger cannot drift apart.
 *
 * `version` starts at 1 and increments ONLY when the balance changes. It also equals the
 * `walletVersion` of the latest ledger entry (checked by a deferred constraint trigger in the DB).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (!props.id) throw new InvalidWalletError('wallet id is required');
    if (!props.playerId || props.playerId.trim() === '') throw new InvalidWalletError('playerId is required');
    if (props.initialBalance.isNegative()) throw new InvalidWalletError('initial balance must not be negative');
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstruction from persistence: does not revalidate anything beyond shape. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * The CREDIT entry that corresponds to a freshly opened wallet's initial balance (version 1).
   * Returns undefined for a zero opening balance (no balance change, no ledger line).
   */
  openingEntry(ctx: MovementContext): WalletLedgerEntry | undefined {
    if (this._version !== 1) throw new InvalidWalletError('opening entry is only valid for a freshly opened wallet');
    if (this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: ctx.now,
    });
  }

  canDebit(amount: Money): boolean {
    this.assertSameCurrency(amount);
    return !this._balance.isLessThan(amount);
  }

  debit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    this.assertPositive(amount);
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(`balance ${this._balance.toString()} is lower than ${amount.toString()}`);
    }
    return this.move(LedgerDirection.Debit, amount, this._balance.subtract(amount), ctx);
  }

  credit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    this.assertPositive(amount);
    return this.move(LedgerDirection.Credit, amount, this._balance.add(amount), ctx);
  }

  private move(direction: LedgerDirection, amount: Money, balanceAfter: Money, ctx: MovementContext): WalletLedgerEntry {
    const nextVersion = this._version + 1;
    // Build (and validate) the ledger entry before mutating, so a failure leaves the aggregate untouched.
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      walletVersion: nextVersion,
      direction,
      money: amount,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: ctx.now,
    });
    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = ctx.now;
    return entry;
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) throw new InvalidWalletError('movement amount must be positive');
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
