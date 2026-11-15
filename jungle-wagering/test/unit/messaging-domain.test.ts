import { describe, expect, test } from 'bun:test';
import { InvalidMessageStateError } from '../../src/domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from '../../src/domain/events';
import { FailureCode } from '../../src/domain/failure-code';
import { InboxMessage } from '../../src/domain/inbox-message';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/domain/backoff';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-15T12:00:00.000Z');
const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: t0 };

const tx = (kind: WagerTransactionKind = WagerTransactionKind.Bet) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'k-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    createdAt: t0,
    ...(kind === WagerTransactionKind.Refund ? { referenceExternalTransactionId: 'bet-1' } : {}),
  });

describe('InboxMessage', () => {
  const msg = () => InboxMessage.receive({ messageId: 'm-1', consumerName: 'c', payloadHash: 'h', receivedAt: t0 });

  test('is received unprocessed and can be processed exactly once', () => {
    const m = msg();
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(t0);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(t0);
    expect(() => m.markProcessed(t0)).toThrow(InvalidMessageStateError);
  });

  test('requires ids and rehydrates persisted state', () => {
    expect(() => InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', receivedAt: t0 })).toThrow(
      InvalidMessageStateError,
    );
    const restored = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: t0, processedAt: t0 });
    expect(restored.isProcessed()).toBe(true);
  });
});

describe('Integration events', () => {
  test('WalletBalanceChanged serialises to a stable, versioned envelope with money as decimal strings', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'), now: t0 });
    const entry = wallet.debit(brl('25.00'), { entryId: 'e-1', transactionId: 'tx-1', now: t0 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = event.toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-11-15T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    // JSON-safe: no Money instances, no Dates, no bigint
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('event type and version live in the type, one concrete class per event', () => {
    const processed = tx();
    processed.markProcessed(undefined, t0, brl('75.00'));
    const rejected = tx();
    rejected.reject(FailureCode.InsufficientFunds, t0, brl('5.00'));
    const pending = tx(WagerTransactionKind.Refund);
    pending.markPendingReference(t0, DEFAULT_REFERENCE_RETRY_POLICY);

    const events = [
      WagerTransactionProcessed.from(processed, ctx),
      WagerTransactionRejected.from(rejected, ctx),
      WagerTransactionPendingReference.from(pending, ctx),
    ];
    expect(events.map((e) => e.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WagerTransactionPendingReference',
    ]);
    expect(events.every((e) => e.version === 1)).toBe(true);
    // every event is partitioned by wallet: the wallet is the unit of ordering
    expect(events.every((e) => e.aggregateId === 'wallet-1')).toBe(true);
  });

  test('Rejected carries the failureCode; Processed carries the observed balance', () => {
    const rejected = tx();
    rejected.reject(FailureCode.InsufficientFunds, t0, brl('5.00'));
    const rejectedData = WagerTransactionRejected.from(rejected, ctx).data;
    expect(rejectedData.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejectedData.balance).toEqual({ amount: '5.00', currency: 'BRL' });

    const processed = tx();
    processed.markProcessed(undefined, t0, brl('75.00'));
    expect(WagerTransactionProcessed.from(processed, ctx).data.balance.amount).toBe('75.00');
  });

  test('event data is frozen', () => {
    const processed = tx();
    processed.markProcessed(undefined, t0, brl('75.00'));
    const event = WagerTransactionProcessed.from(processed, ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test('causationId is omitted from the envelope when absent', () => {
    const processed = tx();
    processed.markProcessed(undefined, t0, brl('75.00'));
    const json = WagerTransactionProcessed.from(processed, { ...ctx, causationId: undefined }).toJSON();
    expect('causationId' in json).toBe(false);
  });
});

describe('OutboxMessage', () => {
  const outbox = () => {
    const processed = tx();
    processed.markProcessed(undefined, t0, brl('75.00'));
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(processed, ctx));
  };

  test('enqueue turns the event into a pending, immediately due row keyed by the eventId', () => {
    const message = outbox();
    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload.eventId).toBe('evt-1');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(t0)).toBe(true);
    expect(message.isDue(new Date(t0.getTime() - 1))).toBe(false);
  });

  test('scheduleRetry increments attempts and backs off exponentially, capped at 60s', () => {
    const message = outbox();
    const delays: number[] = [];
    let now = t0;
    for (let i = 0; i < 9; i++) {
      message.scheduleRetry(now, 'broker down');
      delays.push(message.nextAttemptAt.getTime() - now.getTime());
      now = message.nextAttemptAt;
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(message.attempts).toBe(9);
    expect(message.lastError).toBe('broker down');
    expect(message.isDue(new Date(message.nextAttemptAt.getTime() - 1))).toBe(false);
  });

  test('markPublished is terminal: no longer pending, due or retryable', () => {
    const message = outbox();
    message.scheduleRetry(t0, 'x');
    message.markPublished(t0);
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(t0);
    expect(message.lastError).toBeUndefined();
    expect(message.isDue(new Date(t0.getTime() + 10 ** 9))).toBe(false);
    expect(() => message.markPublished(t0)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(t0)).toThrow(InvalidMessageStateError);
  });
});
