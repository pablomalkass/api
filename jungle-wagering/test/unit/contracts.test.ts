import { describe, expect, test } from 'bun:test';
import { InvalidPayloadError } from '../../src/application/errors';
import {
  parseCreateWalletCommand,
  parseQueueEnvelope,
  parseSubmitCommand,
} from '../../src/application/parsers';
import { canonicalJson, computePayloadHash } from '../../src/application/payload-hash';
import { decodeCursor, encodeCursor } from '../../src/application/queries';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

const body = (over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

const KEY = 'provider-a:transaction-123';

function failure(fn: () => unknown): InvalidPayloadError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidPayloadError);
    return error as InvalidPayloadError;
  }
  throw new Error('expected the parser to throw');
}

const fieldsOf = (error: InvalidPayloadError) => error.details.map((d) => d.field);

describe('canonical JSON and payloadHash', () => {
  test('key order is irrelevant, nested too', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test('undefined fields are omitted, arrays keep their order', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  test('the hash does not depend on key order or on the idempotency key (transport metadata)', () => {
    const a = parseSubmitCommand(body(), KEY);
    const reordered = parseSubmitCommand(
      {
        money: { currency: 'BRL', amount: '25.00' },
        kind: 'BET',
        gameId: 'fortune-chimp',
        roundId: 'round-987',
        walletId: WALLET,
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        externalTransactionId: 'transaction-123',
        providerId: 'provider-a',
      },
      'another-key',
    );
    expect(computePayloadHash(a)).toBe(computePayloadHash(reordered));
    expect(computePayloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('money is normalised before hashing ("25.5" equals "25.50")', () => {
    const a = parseSubmitCommand(body({ money: { amount: '25.5', currency: 'BRL' } }), KEY);
    const b = parseSubmitCommand(body({ money: { amount: '25.50', currency: 'BRL' } }), KEY);
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['kind', { kind: 'WIN' }],
    ['round', { roundId: 'round-988' }],
    ['game', { gameId: 'other' }],
    ['player', { playerId: 'p2' }],
    ['external id', { externalTransactionId: 'transaction-124' }],
  ])('a different %s changes the hash', (_name, over) => {
    expect(computePayloadHash(parseSubmitCommand(body(over), KEY))).not.toBe(
      computePayloadHash(parseSubmitCommand(body(), KEY)),
    );
  });

  test('the reference is part of the business payload', () => {
    const refund = body({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' });
    const other = body({ kind: 'REFUND', referenceExternalTransactionId: 'bet-2' });
    expect(computePayloadHash(parseSubmitCommand(refund, KEY))).not.toBe(computePayloadHash(parseSubmitCommand(other, KEY)));
  });
});

describe('parseSubmitCommand', () => {
  test('accepts the contract example and normalises money and ids', () => {
    const cmd = parseSubmitCommand(body({ walletId: WALLET.toUpperCase() }), KEY);
    expect(cmd.walletId).toBe(WALLET);
    expect(cmd.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(cmd.idempotencyKey).toBe(KEY);
  });

  test('the Idempotency-Key is mandatory', () => {
    expect(fieldsOf(failure(() => parseSubmitCommand(body(), undefined)))).toContain('idempotencyKey');
    expect(fieldsOf(failure(() => parseSubmitCommand(body(), '   ')))).toContain('idempotencyKey');
    expect(fieldsOf(failure(() => parseSubmitCommand(body(), 'x'.repeat(257))))).toContain('idempotencyKey');
  });

  test('OPENING is internal and can never be submitted', () => {
    const error = failure(() => parseSubmitCommand(body({ kind: 'OPENING' }), KEY));
    expect(error.details.find((d) => d.field === 'kind')?.message).toContain('internal');
  });

  test('the "internal" provider id is reserved', () => {
    expect(fieldsOf(failure(() => parseSubmitCommand(body({ providerId: 'internal' }), KEY)))).toContain('providerId');
  });

  test('REFUND and ROLLBACK need a reference; BET must not have one', () => {
    expect(fieldsOf(failure(() => parseSubmitCommand(body({ kind: 'REFUND' }), KEY)))).toContain('referenceExternalTransactionId');
    expect(fieldsOf(failure(() => parseSubmitCommand(body({ kind: 'ROLLBACK' }), KEY)))).toContain('referenceExternalTransactionId');
    expect(
      fieldsOf(failure(() => parseSubmitCommand(body({ referenceExternalTransactionId: 'x' }), KEY))),
    ).toContain('referenceExternalTransactionId');
    expect(parseSubmitCommand(body({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }), KEY).kind).toBe('REFUND');
  });

  test('amount must be positive, except LOSS', () => {
    expect(fieldsOf(failure(() => parseSubmitCommand(body({ money: { amount: '0.00', currency: 'BRL' } }), KEY)))).toContain(
      'money.amount',
    );
    expect(parseSubmitCommand(body({ kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }), KEY).kind).toBe('LOSS');
  });

  test.each([
    [{ money: { amount: 25, currency: 'BRL' } }, 'money'],
    [{ money: { amount: '-5.00', currency: 'BRL' } }, 'money'],
    [{ money: { amount: '1e3', currency: 'BRL' } }, 'money'],
    [{ money: { amount: '1.234', currency: 'BRL' } }, 'money'],
    [{ money: { amount: '1.00', currency: 'real' } }, 'money'],
    [{ money: 'oops' }, 'money'],
    [{ walletId: 'not-a-uuid' }, 'walletId'],
    [{ kind: 'CHARGEBACK' }, 'kind'],
    [{ providerId: '' }, 'providerId'],
    [{ roundId: undefined }, 'roundId'],
    [{ gameId: 42 }, 'gameId'],
  ])('rejects %j', (over, field) => {
    expect(fieldsOf(failure(() => parseSubmitCommand(body(over), KEY)))).toContain(field);
  });

  test('reports every problem at once, not only the first', () => {
    const error = failure(() => parseSubmitCommand({ kind: 'WIN' }, undefined));
    expect(error.details.length).toBeGreaterThan(4);
  });

  test('rejects non-objects', () => {
    for (const input of [null, 'x', 42, [], undefined]) failure(() => parseSubmitCommand(input, KEY));
  });
});

describe('parseCreateWalletCommand', () => {
  test('accepts the contract example', () => {
    const cmd = parseCreateWalletCommand({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(cmd.initialBalance.toJSON().amount).toBe('1000.00');
  });

  test('rejects missing player and negative or malformed balance', () => {
    expect(fieldsOf(failure(() => parseCreateWalletCommand({ initialBalance: { amount: '1.00', currency: 'BRL' } })))).toContain(
      'playerId',
    );
    expect(fieldsOf(failure(() => parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } })))).toContain(
      'initialBalance',
    );
    expect(fieldsOf(failure(() => parseCreateWalletCommand({ playerId: 'p' })))).toContain('initialBalance');
  });
});

describe('parseQueueEnvelope', () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: { ...body(), idempotencyKey: KEY },
    ...over,
  });

  test('accepts the contract example and applies the same business validation as HTTP', () => {
    const parsed = parseQueueEnvelope(envelope());
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.command.idempotencyKey).toBe(KEY);
    expect(parsed.command.money.toJSON().amount).toBe('25.00');
  });

  test('rejects an unknown type, a bad timestamp, a missing id or missing data', () => {
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ type: 'Other' }))))).toContain('type');
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ occurredAt: 'yesterday' }))))).toContain('occurredAt');
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ messageId: undefined }))))).toContain('messageId');
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ data: undefined }))))).toContain('data');
  });

  test('a message with OPENING, or without idempotencyKey, is invalid', () => {
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ data: { ...body({ kind: 'OPENING' }), idempotencyKey: KEY } }))))).toContain('kind');
    expect(fieldsOf(failure(() => parseQueueEnvelope(envelope({ data: body() }))))).toContain('idempotencyKey');
  });
});

describe('ledger cursor', () => {
  test('round-trips and is opaque', () => {
    const cursor = encodeCursor(42);
    expect(cursor).not.toContain('42');
    expect(decodeCursor(cursor)).toBe(42);
  });

  test.each([['!!!'], [''], [Buffer.from('{"v":"x"}').toString('base64url')], [Buffer.from('{"v":0}').toString('base64url')]])(
    'rejects garbage %p',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(InvalidPayloadError);
    },
  );
});
