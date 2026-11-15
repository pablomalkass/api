import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { settle } from '../../src/domain/settlement';
import { Wallet } from '../../src/domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-15T12:00:00.000Z');

let seq = 0;
const wallet = (balance = '100.00') => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(balance), now });

function tx(kind: Kind, amount: string, over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  seq += 1;
  const needsRef = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `k-${seq}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: now,
    ...(needsRef ? { referenceExternalTransactionId: 'ref' } : {}),
    ...over,
  });
}

const processed = (kind: Kind, amount: string, over: Partial<CreateWagerTransactionProps> = {}) => {
  const reference = tx(kind, amount, over);
  reference.markProcessed(undefined, now, brl('0.00'));
  return reference;
};

const run = (w: Wallet, t: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) =>
  settle({ wallet: w, transaction: t, reference, referenceAlreadyReversed, entryId: 'entry-1', now });

describe('BET', () => {
  test('debits the wallet with one DEBIT entry', () => {
    const w = wallet('100.00');
    const outcome = run(w, tx(Kind.Bet, '30.00'));
    expect(outcome.type).toBe('APPLIED');
    if (outcome.type !== 'APPLIED') throw new Error('unreachable');
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('70.00');
  });

  test('is rejected for insufficient balance, leaving the wallet untouched (the 80/80 scenario)', () => {
    const w = wallet('20.00');
    const outcome = run(w, tx(Kind.Bet, '80.00'));
    expect(outcome).toEqual({ type: 'REJECTED', code: FailureCode.InsufficientFunds });
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('may spend the exact balance', () => {
    const w = wallet('80.00');
    expect(run(w, tx(Kind.Bet, '80.00')).type).toBe('APPLIED');
    expect(w.balance.isZero()).toBe(true);
  });
});

describe('WIN', () => {
  test('credits the wallet with one CREDIT entry', () => {
    const w = wallet('10.00');
    const outcome = run(w, tx(Kind.Win, '55.00'));
    expect(outcome.type === 'APPLIED' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('65.00');
  });

  test('may reference the BET of the same round', () => {
    const bet = processed(Kind.Bet, '10.00');
    expect(run(wallet(), tx(Kind.Win, '30.00', { referenceExternalTransactionId: 'bet' }), bet).type).toBe('APPLIED');
  });

  test('referencing a missing transaction parks it for the worker', () => {
    expect(run(wallet(), tx(Kind.Win, '30.00', { referenceExternalTransactionId: 'bet' }))).toEqual({
      type: 'WAIT_REFERENCE',
      reason: 'REFERENCE_MISSING',
    });
  });
});

describe('LOSS', () => {
  test('is applied without touching the balance and without a ledger entry', () => {
    const w = wallet('100.00');
    const outcome = run(w, tx(Kind.Loss, '25.00'));
    expect(outcome).toEqual({ type: 'APPLIED' });
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits back a processed BET', () => {
    const w = wallet('75.00');
    const bet = processed(Kind.Bet, '25.00');
    const outcome = run(w, tx(Kind.Refund, '25.00'), bet);
    expect(outcome.type === 'APPLIED' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test('waits when the BET has not arrived', () => {
    expect(run(wallet(), tx(Kind.Refund, '25.00'))).toEqual({ type: 'WAIT_REFERENCE', reason: 'REFERENCE_MISSING' });
  });

  test('waits when the BET exists but is not settled', () => {
    const pendingBet = tx(Kind.Bet, '25.00');
    expect(run(wallet(), tx(Kind.Refund, '25.00'), pendingBet)).toEqual({
      type: 'WAIT_REFERENCE',
      reason: 'REFERENCE_UNSETTLED',
    });
  });

  test('is rejected when the BET was already reversed (exactly once)', () => {
    const bet = processed(Kind.Bet, '25.00');
    expect(run(wallet(), tx(Kind.Refund, '25.00'), bet, true)).toEqual({
      type: 'REJECTED',
      code: FailureCode.AlreadyReversed,
    });
  });

  test('is rejected for a different amount, and for a rejected BET', () => {
    const bet = processed(Kind.Bet, '25.00');
    expect(run(wallet(), tx(Kind.Refund, '10.00'), bet)).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceAmountMismatch,
    });
    const rejectedBet = tx(Kind.Bet, '25.00');
    rejectedBet.reject(FailureCode.InsufficientFunds, now, brl('0.00'));
    expect(run(wallet(), tx(Kind.Refund, '25.00'), rejectedBet)).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceRejected,
    });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits the player back', () => {
    const w = wallet('50.00');
    const outcome = run(w, tx(Kind.Rollback, '25.00'), processed(Kind.Bet, '25.00'));
    expect(outcome.type === 'APPLIED' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('75.00');
  });

  test('of a WIN takes the money back (DEBIT)', () => {
    const w = wallet('200.00');
    const outcome = run(w, tx(Kind.Rollback, '150.00'), processed(Kind.Win, '150.00'));
    expect(outcome.type === 'APPLIED' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('50.00');
  });

  test('of a REFUND takes the refunded money back (DEBIT)', () => {
    const w = wallet('100.00');
    const refund = processed(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet' });
    const outcome = run(w, tx(Kind.Rollback, '25.00'), refund);
    expect(outcome.type === 'APPLIED' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('75.00');
  });

  test('that would drive the balance negative is rejected with a code distinct from INSUFFICIENT_FUNDS', () => {
    const w = wallet('10.00'); // the player already spent the winnings
    const outcome = run(w, tx(Kind.Rollback, '150.00'), processed(Kind.Win, '150.00'));
    expect(outcome).toEqual({ type: 'REJECTED', code: FailureCode.ReversalWouldOverdraw });
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('of an already reversed transaction is rejected', () => {
    expect(run(wallet(), tx(Kind.Rollback, '25.00'), processed(Kind.Bet, '25.00'), true)).toEqual({
      type: 'REJECTED',
      code: FailureCode.AlreadyReversed,
    });
  });
});

describe('ownership and currency guards', () => {
  test('a player that does not own the wallet is rejected', () => {
    const w = wallet();
    expect(run(w, tx(Kind.Bet, '1.00', { playerId: 'someone-else' }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.WalletPlayerMismatch,
    });
    expect(w.version).toBe(1);
  });

  test('a currency different from the wallet currency is rejected', () => {
    const w = wallet();
    const usdBet = tx(Kind.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(run(w, usdBet)).toEqual({ type: 'REJECTED', code: FailureCode.CurrencyMismatch });
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test('OPENING never goes through the wagering flow', () => {
    expect(() => run(wallet(), tx(Kind.Opening, '1.00', { providerId: 'internal' }))).toThrow(InvalidTransactionError);
  });
});
