import { computeBackoffMs, type ReferenceRetryPolicy } from './backoff';
import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  /** Internal: credit of a wallet's initial balance. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied. Only observable inside the processing transaction. */
  Pending = 'PENDING',
  /** Persisted and waiting for the referenced transaction to arrive / settle. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business-rule violation (terminal, auditable, carries a failureCode). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure/invariant failure (terminal, auditable, carries a failureCode). */
  Failed = 'FAILED',
}

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | PENDING_REFERENCE (retry rescheduled) | REJECTED | FAILED
 *   PROCESSED | REJECTED | FAILED -> (terminal: no transitions)
 */
const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id of the referenced transaction at the PROVIDER (not our internal id). */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Wallet balance observed when the transaction settled. Replays return exactly this. */
  observedBalance?: Money;
  processedAt?: Date;
  referenceAttempts: number;
  referenceNextAttemptAt?: Date;
  referenceDeadlineAt?: Date;
}

export type ReferenceEvaluation =
  | { type: 'OK' }
  | { type: 'WAIT' }
  | { type: 'REJECT'; code: FailureCode };

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _observedBalance: Money | undefined;
  private _processedAt: Date | undefined;
  private _referenceAttempts: number;
  private _referenceNextAttemptAt: Date | undefined;
  private _referenceDeadlineAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._observedBalance = state.observedBalance;
    this._processedAt = state.processedAt;
    this._referenceAttempts = state.referenceAttempts;
    this._referenceNextAttemptAt = state.referenceNextAttemptAt;
    this._referenceDeadlineAt = state.referenceDeadlineAt;
  }

  /** Nasce em PENDING. Validates the shape and the reference requirement of each kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const reference = props.referenceExternalTransactionId;
    const needsReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && (reference === undefined || reference === '')) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (
      (props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Opening) &&
      reference !== undefined
    ) {
      throw new InvalidTransactionError(`${props.kind} cannot reference another transaction`);
    }
    if (props.money.isNegative()) {
      throw new InvalidTransactionError('money must not be negative');
    }
    if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Loss) {
      throw new InvalidTransactionError(`${props.kind} amount must be greater than zero`);
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /** Reconstruction from persistence: does NOT revalidate transition rules, only rebuilds persisted state. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get referenceNextAttemptAt(): Date | undefined {
    return this._referenceNextAttemptAt;
  }
  get referenceDeadlineAt(): Date | undefined {
    return this._referenceDeadlineAt;
  }

  // ---- transitions -------------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this.clearSchedule();
  }

  /**
   * First call (from PENDING) opens the retry budget; later calls (from PENDING_REFERENCE) count a failed
   * resolution attempt and reschedule with exponential backoff.
   */
  markPendingReference(at: Date, policy: ReferenceRetryPolicy, jitter01 = 0.5): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status === WagerTransactionStatus.Pending) {
      this._referenceAttempts = 1;
      this._referenceDeadlineAt = new Date(at.getTime() + policy.ttlMs);
    } else {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceNextAttemptAt = new Date(
      at.getTime() + computeBackoffMs(this._referenceAttempts, policy.baseDelayMs, policy.maxDelayMs, jitter01),
    );
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this.clearSchedule();
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this.clearSchedule();
  }

  // ---- domain queries ----------------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS records an outcome without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND and ROLLBACK must name the transaction they revert. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** True when the reference retry budget (attempts or TTL) is exhausted. */
  referenceBudgetExhausted(now: Date, policy: ReferenceRetryPolicy): boolean {
    if (this._referenceAttempts >= policy.maxAttempts) return true;
    return this._referenceDeadlineAt !== undefined && now.getTime() >= this._referenceDeadlineAt.getTime();
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * ROLLBACK is the inverse of the direction of the transaction it reverts.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError('ROLLBACK needs its reference to know the direction');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS has no ledger direction');
    }
  }

  /**
   * Checks a candidate reference against this transaction. Pure: it never mutates anything.
   * Order: identity (provider/player/wallet/currency/round) -> kind -> amount -> settlement status.
   */
  evaluateReference(reference: WagerTransaction): ReferenceEvaluation {
    const reject = (code: FailureCode): ReferenceEvaluation => ({ type: 'REJECT', code });
    if (reference.id === this.id) return reject(FailureCode.ReferenceInvalidKind);
    if (reference.providerId !== this.providerId) return reject(FailureCode.ReferenceMismatchProvider);
    if (reference.playerId !== this.playerId) return reject(FailureCode.ReferenceMismatchPlayer);
    if (reference.walletId !== this.walletId) return reject(FailureCode.ReferenceMismatchWallet);
    if (reference.money.currency !== this.money.currency) return reject(FailureCode.ReferenceMismatchCurrency);
    if (reference.roundId !== this.roundId) return reject(FailureCode.ReferenceMismatchRound);

    if (!this.allowedReferenceKinds().includes(reference.kind)) return reject(FailureCode.ReferenceInvalidKind);

    if (this.isReversal() && !reference.money.equals(this.money)) return reject(FailureCode.ReferenceAmountMismatch);

    switch (reference.status) {
      case WagerTransactionStatus.Processed:
        return { type: 'OK' };
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
        return { type: 'WAIT' };
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return reject(FailureCode.ReferenceRejected);
    }
  }

  private allowedReferenceKinds(): WagerTransactionKind[] {
    switch (this.kind) {
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Refund:
        return [WagerTransactionKind.Bet];
      case WagerTransactionKind.Rollback:
        return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
      default:
        return [];
    }
  }

  private clearSchedule(): void {
    this._referenceNextAttemptAt = undefined;
    this._referenceDeadlineAt = undefined;
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${action}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
