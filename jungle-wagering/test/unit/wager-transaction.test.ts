import { describe, expect, test } from 'bun:test';
import { DEFAULT_REFERENCE_RETRY_POLICY, computeBackoffMs } from '../../src/domain/backoff';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-15T12:00:00.000Z');

let seq = 0;
function props(kind: Kind, over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  seq += 1;
  return {
    id: `id-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    createdAt: t0,
    ...over,
  };
}

const make = (kind: Kind, over: Partial<CreateWagerTransactionProps> = {}) => {
  const needsRef = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create(props(kind, { ...(needsRef ? { referenceExternalTransactionId: 'ref' } : {}), ...over }));
};

/** A processed reference of a given kind, rehydrated as the database would return it. */
const processedRef = (kind: Kind, over: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = WagerTransaction.create(props(kind, over));
  tx.markProcessed(undefined, t0, brl('100.00'));
  return tx;
};

describe('WagerTransaction.create', () => {
  test('is born PENDING', () => {
    const tx = make(Kind.Bet);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => WagerTransaction.create(props(Kind.Refund))).toThrow(InvalidTransactionError);
    expect(() => WagerTransaction.create(props(Kind.Rollback))).toThrow(InvalidTransactionError);
    expect(() => WagerTransaction.create(props(Kind.Refund, { referenceExternalTransactionId: '' }))).toThrow(
      InvalidTransactionError,
    );
    expect(make(Kind.Refund).requiresReference()).toBe(true);
    expect(make(Kind.Rollback).requiresReference()).toBe(true);
  });

  test('BET and OPENING cannot carry a reference; WIN and LOSS may', () => {
    expect(() => WagerTransaction.create(props(Kind.Bet, { referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidTransactionError,
    );
    expect(() => WagerTransaction.create(props(Kind.Opening, { referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidTransactionError,
    );
    expect(make(Kind.Win, { referenceExternalTransactionId: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
    expect(make(Kind.Win).requiresReference()).toBe(false);
  });

  test('amounts must be positive, except LOSS which may be zero', () => {
    expect(() => make(Kind.Bet, { money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(() => make(Kind.Win, { money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(make(Kind.Loss, { money: brl('0.00') }).kind).toBe(Kind.Loss);
    expect(() => make(Kind.Bet, { money: brl('1.00').negate() })).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction state machine', () => {
  test('PENDING -> PROCESSED records reference, observed balance and time', () => {
    const tx = make(Kind.Bet);
    tx.markProcessed('ref-id', t0, brl('75.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.observedBalance?.toJSON().amount).toBe('75.00');
    expect(tx.processedAt).toEqual(t0);
  });

  test('PENDING -> REJECTED records the failure code and the observed balance', () => {
    const tx = make(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds, t0, brl('20.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.toJSON().amount).toBe('20.00');
  });

  test('PENDING -> FAILED', () => {
    const tx = make(Kind.Bet);
    tx.fail(FailureCode.InternalError, t0);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalError);
    expect(tx.isTerminal()).toBe(true);
  });

  test.each([
    ['markProcessed', (tx: WagerTransaction) => tx.markProcessed(undefined, t0, brl('1.00'))],
    ['markPendingReference', (tx: WagerTransaction) => tx.markPendingReference(t0, DEFAULT_REFERENCE_RETRY_POLICY)],
    ['reject', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, t0, brl('1.00'))],
    ['fail', (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, t0)],
  ])('every transition out of a terminal state throws (%s)', (_name, transition) => {
    for (const terminate of [
      (tx: WagerTransaction) => tx.markProcessed(undefined, t0, brl('1.00')),
      (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, t0, brl('1.00')),
      (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, t0),
    ]) {
      const tx = make(Kind.Bet);
      terminate(tx);
      const statusBefore = tx.status;
      expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(statusBefore);
    }
  });

  describe('PENDING_REFERENCE retry budget', () => {
    const policy = { maxAttempts: 3, ttlMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000 };

    test('first call opens the budget; later calls count attempts and reschedule with backoff', () => {
      const tx = make(Kind.Refund);
      tx.markPendingReference(t0, policy, 0.5);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.referenceDeadlineAt).toEqual(new Date(t0.getTime() + 60_000));
      expect(tx.referenceNextAttemptAt).toEqual(new Date(t0.getTime() + 1_000));

      const t1 = new Date(t0.getTime() + 1_000);
      tx.markPendingReference(t1, policy, 0.5);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.referenceNextAttemptAt).toEqual(new Date(t1.getTime() + 2_000));
      // the TTL is anchored to the FIRST attempt and never slides
      expect(tx.referenceDeadlineAt).toEqual(new Date(t0.getTime() + 60_000));
    });

    test('budget is exhausted by attempts or by TTL, whichever hits first', () => {
      const byAttempts = make(Kind.Refund);
      byAttempts.markPendingReference(t0, policy);
      byAttempts.markPendingReference(t0, policy);
      expect(byAttempts.referenceBudgetExhausted(t0, policy)).toBe(false);
      byAttempts.markPendingReference(t0, policy);
      expect(byAttempts.referenceBudgetExhausted(t0, policy)).toBe(true);

      const byTtl = make(Kind.Refund);
      byTtl.markPendingReference(t0, policy);
      expect(byTtl.referenceBudgetExhausted(new Date(t0.getTime() + 59_999), policy)).toBe(false);
      expect(byTtl.referenceBudgetExhausted(new Date(t0.getTime() + 60_000), policy)).toBe(true);
    });

    test('PENDING_REFERENCE can still be resolved to PROCESSED / REJECTED, which clears the schedule', () => {
      const tx = make(Kind.Refund);
      tx.markPendingReference(t0, policy);
      tx.markProcessed('ref-id', t0, brl('10.00'));
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceNextAttemptAt).toBeUndefined();
      expect(tx.referenceDeadlineAt).toBeUndefined();
    });

    test('backoff is exponential, capped, and jittered within +-20%', () => {
      expect(computeBackoffMs(1, 1_000, 10_000, 0.5)).toBe(1_000);
      expect(computeBackoffMs(2, 1_000, 10_000, 0.5)).toBe(2_000);
      expect(computeBackoffMs(3, 1_000, 10_000, 0.5)).toBe(4_000);
      expect(computeBackoffMs(10, 1_000, 10_000, 0.5)).toBe(10_000);
      expect(computeBackoffMs(2, 1_000, 10_000, 0)).toBe(1_600);
      expect(computeBackoffMs(2, 1_000, 10_000, 0.999)).toBeLessThanOrEqual(2_400);
    });
  });
});

describe('WagerTransaction domain queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    expect(make(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback, Kind.Opening]) {
      expect(make(kind).affectsBalance()).toBe(true);
    }
  });

  test('matchesPayload compares the stored hash', () => {
    const tx = make(Kind.Bet, { payloadHash: 'b'.repeat(64) });
    expect(tx.matchesPayload('b'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });

  test('ledger direction: BET debits; WIN, REFUND, OPENING credit; LOSS has none', () => {
    expect(make(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => make(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('ROLLBACK is the inverse of whatever it reverts', () => {
    const rollback = make(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(processedRef(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processedRef(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processedRef(Kind.Refund, { referenceExternalTransactionId: 'b' }))).toBe(
      LedgerDirection.Debit,
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction.evaluateReference', () => {
  const sameScope = { walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1', providerId: 'provider-a' };

  test('a matching processed BET is accepted by REFUND, ROLLBACK, WIN and LOSS', () => {
    const bet = processedRef(Kind.Bet, sameScope);
    for (const kind of [Kind.Refund, Kind.Rollback, Kind.Win, Kind.Loss]) {
      expect(make(kind, { ...sameScope, referenceExternalTransactionId: 'b' }).evaluateReference(bet)).toEqual({ type: 'OK' });
    }
  });

  test('REFUND may only reference a BET', () => {
    const win = processedRef(Kind.Win, sameScope);
    expect(make(Kind.Refund).evaluateReference(win)).toEqual({ type: 'REJECT', code: FailureCode.ReferenceInvalidKind });
  });

  test('ROLLBACK may reference BET, WIN or REFUND, but not LOSS or another ROLLBACK', () => {
    const rollback = make(Kind.Rollback, { money: brl('25.00') });
    expect(rollback.evaluateReference(processedRef(Kind.Win, sameScope))).toEqual({ type: 'OK' });
    expect(rollback.evaluateReference(processedRef(Kind.Refund, { ...sameScope, referenceExternalTransactionId: 'b' }))).toEqual({
      type: 'OK',
    });
    expect(rollback.evaluateReference(processedRef(Kind.Loss, sameScope))).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceInvalidKind,
    });
    expect(
      rollback.evaluateReference(processedRef(Kind.Rollback, { ...sameScope, referenceExternalTransactionId: 'b' })),
    ).toEqual({ type: 'REJECT', code: FailureCode.ReferenceInvalidKind });
  });

  test.each([
    ['provider', { providerId: 'provider-b' }, FailureCode.ReferenceMismatchProvider],
    ['player', { playerId: 'player-2' }, FailureCode.ReferenceMismatchPlayer],
    ['wallet', { walletId: 'wallet-2' }, FailureCode.ReferenceMismatchWallet],
    ['round', { roundId: 'round-2' }, FailureCode.ReferenceMismatchRound],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }, FailureCode.ReferenceMismatchCurrency],
  ])('reference from another %s is rejected', (_name, over, code) => {
    const reference = processedRef(Kind.Bet, { ...sameScope, ...over });
    expect(make(Kind.Refund).evaluateReference(reference)).toEqual({ type: 'REJECT', code });
  });

  test('REFUND/ROLLBACK amount must equal the reference amount (no partial reversal)', () => {
    const bet = processedRef(Kind.Bet, { ...sameScope, money: brl('25.00') });
    expect(make(Kind.Refund, { money: brl('24.99') }).evaluateReference(bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceAmountMismatch,
    });
    expect(make(Kind.Rollback, { money: brl('25.01') }).evaluateReference(bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceAmountMismatch,
    });
    // WIN/LOSS amounts are independent of the stake
    expect(make(Kind.Win, { money: brl('900.00') }).evaluateReference(bet)).toEqual({ type: 'OK' });
  });

  test('settlement status of the reference decides between OK, WAIT and REJECT', () => {
    const pending = WagerTransaction.create(props(Kind.Bet, sameScope));
    expect(make(Kind.Refund).evaluateReference(pending)).toEqual({ type: 'WAIT' });

    const parked = WagerTransaction.create(props(Kind.Win, { ...sameScope, referenceExternalTransactionId: 'x' }));
    parked.markPendingReference(t0, DEFAULT_REFERENCE_RETRY_POLICY);
    expect(make(Kind.Rollback).evaluateReference(parked)).toEqual({ type: 'WAIT' });

    const rejected = WagerTransaction.create(props(Kind.Bet, sameScope));
    rejected.reject(FailureCode.InsufficientFunds, t0, brl('0.00'));
    expect(make(Kind.Refund).evaluateReference(rejected)).toEqual({ type: 'REJECT', code: FailureCode.ReferenceRejected });

    const failed = WagerTransaction.create(props(Kind.Bet, sameScope));
    failed.fail(FailureCode.InternalError, t0);
    expect(make(Kind.Refund).evaluateReference(failed)).toEqual({ type: 'REJECT', code: FailureCode.ReferenceRejected });
  });

  test('a transaction cannot reference itself', () => {
    const tx = make(Kind.Rollback);
    expect(tx.evaluateReference(tx)).toEqual({ type: 'REJECT', code: FailureCode.ReferenceInvalidKind });
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('rebuilds terminal state without running transition rules', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(Kind.Bet),
      status: Status.Processed,
      observedBalance: brl('5.00'),
      processedAt: t0,
      referenceAttempts: 0,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, t0, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });
});
