import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
  LedgerEntryUnbalancedError,
} from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-15T12:00:00.000Z');
const later = new Date('2026-11-15T12:00:05.000Z');

const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), now });
const move = (n: number) => ({ entryId: `e-${n}`, transactionId: `t-${n}`, now: later });

describe('Wallet', () => {
  test('opens at version 1 with the initial balance', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(now);
    expect(wallet.updatedAt).toEqual(now);
  });

  test('debit lowers the balance, bumps the version and returns the matching ledger entry', () => {
    const wallet = openWallet();
    const entry = wallet.debit(brl('80.00'), move(1));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe('t-1');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit raises the balance and returns a CREDIT entry', () => {
    const wallet = openWallet();
    const entry = wallet.credit(brl('25.50'), move(1));
    expect(wallet.balance.toJSON().amount).toBe('125.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('the balance can be drained to exactly zero but never below', () => {
    const wallet = openWallet('10.00');
    wallet.debit(brl('10.00'), move(1));
    expect(wallet.balance.isZero()).toBe(true);
    expect(() => wallet.debit(brl('0.01'), move(2))).toThrow(InsufficientFundsError);
  });

  test('a rejected debit leaves balance, version and updatedAt untouched', () => {
    const wallet = openWallet('50.00');
    expect(() => wallet.debit(brl('50.01'), move(1))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(now);
  });

  test('the version increments only when the balance changes, one step per movement', () => {
    const wallet = openWallet();
    wallet.canDebit(brl('10.00'));
    expect(wallet.version).toBe(1);
    wallet.debit(brl('10.00'), move(1));
    wallet.credit(brl('5.00'), move(2));
    wallet.debit(brl('1.00'), move(3));
    expect(wallet.version).toBe(4);
  });

  test('currency conflicts are domain errors', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, move(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, move(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero-amount movements are rejected (they would create meaningless ledger lines)', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(brl('0.00'), move(1))).toThrow(InvalidWalletError);
    expect(() => wallet.debit(brl('0.00'), move(1))).toThrow(InvalidWalletError);
  });

  test('openingEntry credits the whole initial balance at version 1, and is absent for a zero opening', () => {
    const entry = openWallet('300.00').openingEntry({ entryId: 'e-0', transactionId: 't-0', now });
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.isZero()).toBe(true);
    expect(entry?.balanceAfter.toJSON().amount).toBe('300.00');
    expect(entry?.walletVersion).toBe(1);
    expect(openWallet('0.00').openingEntry({ entryId: 'e-0', transactionId: 't-0', now })).toBeUndefined();
  });

  test('openingEntry is only valid for a freshly opened wallet', () => {
    const wallet = openWallet();
    wallet.debit(brl('1.00'), move(1));
    expect(() => wallet.openingEntry({ entryId: 'e-0', transactionId: 't-0', now })).toThrow(InvalidWalletError);
  });

  test('open validates its input', () => {
    expect(() => Wallet.open({ id: '', playerId: 'p', initialBalance: brl('1.00'), now })).toThrow(InvalidWalletError);
    expect(() => Wallet.open({ id: 'w', playerId: ' ', initialBalance: brl('1.00'), now })).toThrow(InvalidWalletError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), now }),
    ).toThrow(InvalidWalletError);
  });

  test('rehydrate rebuilds persisted state as-is, without re-running opening rules', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-9',
      playerId: 'p-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: now,
      updatedAt: later,
    });
    expect(wallet.version).toBe(17);
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.updatedAt).toEqual(later);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    walletVersion: 2,
    createdAt: now,
  };

  test('create verifies the arithmetic', () => {
    const ok = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
    });
    expect(ok.isBalanced()).toBe(true);

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(LedgerEntryUnbalancedError);

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
      }),
    ).toThrow(LedgerEntryUnbalancedError);
  });

  test('create rejects non-positive amounts, negative balances and bad versions', () => {
    const entry = (over: object) =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
        ...over,
      });
    expect(() => entry({ money: brl('0.00'), balanceAfter: brl('0.00') })).toThrow(LedgerEntryUnbalancedError);
    expect(() => entry({ balanceBefore: brl('1.00').negate(), balanceAfter: brl('0.00') })).toThrow(
      LedgerEntryUnbalancedError,
    );
    expect(() => entry({ walletVersion: 0 })).toThrow(LedgerEntryUnbalancedError);
  });

  test('is structurally immutable: no mutators exist on the type', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });

  test('rehydrate does not revalidate persisted state', () => {
    const odd = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('5.00'),
    });
    expect(odd.isBalanced()).toBe(false);
  });
});
