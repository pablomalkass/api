import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  PermanentInfrastructureError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { SubmitResult } from '../../src/application/process-wager-transaction';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { FailureCode } from '../../src/domain/failure-code';
import { JsonLogger, redact } from '../../src/infrastructure/observability/json-logger';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { classifyDbError } from '../../src/infrastructure/persistence/db-errors';
import { toKnexStyleQuery } from '../../src/infrastructure/persistence/sql-params';
import { replyForError, replyForSubmit } from '../../src/interfaces/http/http-mapping';

describe('toKnexStyleQuery ($n -> ? for MikroORM/Knex)', () => {
  test('replaces placeholders and expands bindings in order of appearance', () => {
    expect(toKnexStyleQuery('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 7])).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ?',
      bindings: ['x', 7],
    });
  });

  test('a placeholder used twice (or out of order) is bound twice, in order', () => {
    const q = toKnexStyleQuery('SELECT $2::bigint, $1, $2::bigint IS NULL', ['a', 5]);
    expect(q.sql).toBe('SELECT ?::bigint, ?, ?::bigint IS NULL');
    expect(q.bindings).toEqual([5, 'a', 5]);
  });

  test('keeps casts, string literals (even ones containing $1) and null bindings intact', () => {
    const q = toKnexStyleQuery("UPDATE t SET s = 'PENDING $1 it''s', d = $1::timestamptz WHERE n = $2", ['2026-01-01T00:00:00Z', null]);
    expect(q.sql).toBe("UPDATE t SET s = 'PENDING $1 it''s', d = ?::timestamptz WHERE n = ?");
    expect(q.bindings).toEqual(['2026-01-01T00:00:00Z', null]);
  });

  test('handles $10 and above without confusing it with $1', () => {
    const params = Array.from({ length: 11 }, (_, i) => i);
    expect(toKnexStyleQuery('SELECT $10, $1, $11', params).bindings).toEqual([9, 0, 10]);
  });

  test('rejects a literal ? (Knex would silently treat it as a binding) and missing parameters', () => {
    expect(() => toKnexStyleQuery("SELECT data ? 'k'", [])).toThrow('literal "?"');
    expect(() => toKnexStyleQuery('SELECT $3', ['a'])).toThrow('no matching parameter');
    expect(() => toKnexStyleQuery("SELECT 'oops", [])).toThrow('unterminated');
  });

  test('every statement the repositories issue converts cleanly', async () => {
    const source = await Bun.file(new URL('../../src/infrastructure/persistence/repositories.ts', import.meta.url).pathname).text();
    // JS template interpolations (${...}) are code, not SQL: drop them (the optional FOR UPDATE clause is checked below).
    const statements = [...source.matchAll(/`([^`]*\$\d[^`]*)`/g)].map((m) => (m[1] as string).replace(/\$\{[^}]*\}/g, ''));
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) {
      const max = Math.max(...[...statement.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const q = toKnexStyleQuery(statement, Array.from({ length: max }, (_, i) => `p${i + 1}`));
      expect(q.sql).not.toMatch(/\$\d/);
      expect(q.bindings.length).toBe([...statement.matchAll(/\$\d+/g)].length);
    }
  });
});

describe('structured logging', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    const logger = new JsonLogger({ write: (l) => lines.push(JSON.parse(l)), now: () => new Date('2026-07-29T15:00:00.000Z'), level: 'debug' });
    return { lines, logger };
  };

  test('writes one JSON object with the correlation fields as first-class keys', () => {
    const { lines, logger } = capture();
    logger.info('transaction processed', { correlationId: 'c-1', messageId: 'm-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
    expect(lines[0]).toEqual({
      level: 'info',
      time: '2026-07-29T15:00:00.000Z',
      service: 'wagering',
      msg: 'transaction processed',
      correlationId: 'c-1',
      messageId: 'm-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'p-1',
    });
  });

  test('never logs money, balances or full payloads, at any depth', () => {
    const { lines, logger } = capture();
    logger.warn('x', {
      walletId: 'w',
      money: { amount: '25.00', currency: 'BRL' },
      nested: { balanceAfter: '975.00', ok: 1, deeper: { payload: { secret: 's' }, Amount: '9.99' } },
      list: [{ initialBalance: '1.00', id: 1 }],
    });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain('975.00');
    expect(serialized).not.toContain('9.99');
    expect(serialized).not.toContain('1.00');
    expect(lines[0]).toMatchObject({ walletId: 'w', money: '[REDACTED]', nested: { ok: 1 } });
  });

  test('errors are reduced to name and message (no stack, no cause payloads)', () => {
    expect(redact(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
  });

  test('respects the level', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ level: 'warn', write: (l) => lines.push(l) });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(2);
  });
});

describe('Prometheus exposition', () => {
  test('exposes counters, gauges and histograms in the text format, with escaped labels', () => {
    const m = new PrometheusMetrics();
    m.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' });
    m.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }, 2);
    m.increment('wager_dlq_messages_total', { reason: 'bad "quote"\nx' });
    m.gauge('outbox_lag_seconds', 3.5);
    m.observe('wager_processing_duration_seconds', 0.03, { source: 'http' });
    m.observe('wager_processing_duration_seconds', 20, { source: 'http' });

    const text = m.render();
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 3');
    expect(text).toContain('wager_dlq_messages_total{reason="bad \\"quote\\"\\nx"} 1');
    expect(text).toContain('outbox_lag_seconds 3.5');
    expect(text).toContain('wager_processing_duration_seconds_bucket{le="0.05",source="http"} 1');
    expect(text).toContain('wager_processing_duration_seconds_bucket{le="+Inf",source="http"} 2');
    expect(text).toContain('wager_processing_duration_seconds_count{source="http"} 2');
    expect(text).toContain('wager_processing_duration_seconds_sum{source="http"} 20.03');
  });

  test('every metric the README requires exists even before the first event', () => {
    const text = new PrometheusMetrics().render();
    for (const name of [
      'wager_transactions_total', // transactions by status
      'wager_duplicates_total', // duplicates detected
      'wager_retries_total', // retries
      'wager_dlq_messages_total', // DLQ
      'wallet_lock_conflicts_total', // lock conflicts
      'outbox_lag_seconds', // outbox lag
      'wager_processing_duration_seconds', // latency
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });
});

describe('HTTP status mapping (one consistent contract)', () => {
  const base = { transactionId: 't-1', idempotentReplay: false };
  const result = (over: Partial<SubmitResult>): SubmitResult => ({ ...base, status: WagerTransactionStatus.Processed, ...over });

  test('PROCESSED -> 200, replay included', () => {
    const reply = replyForSubmit(result({ balance: { amount: '975.00', currency: 'BRL' } }));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ transactionId: 't-1', status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(replyForSubmit(result({ idempotentReplay: true })).status).toBe(200);
  });

  test('PENDING_REFERENCE -> 202 with a Location to poll', () => {
    const reply = replyForSubmit(result({ status: WagerTransactionStatus.PendingReference }));
    expect(reply.status).toBe(202);
    expect(reply.headers?.Location).toBe('/wagering/transactions/t-1');
  });

  test('REJECTED -> 422 with the stable failureCode and what the provider should do', () => {
    const reply = replyForSubmit(result({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '20.00', currency: 'BRL' } }));
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', failure: { providerAction: 'RESEND_NEW' } });
  });

  test('the five situations the README says must never be collapsed all get DIFFERENT statuses', () => {
    const statuses = {
      invalidPayload: replyForError(new InvalidPayloadError([{ field: 'x', message: 'y' }])).status,
      idempotencyConflict: replyForError(new IdempotencyConflictError()).status,
      businessRejection: replyForSubmit(result({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds })).status,
      acceptedPending: replyForSubmit(result({ status: WagerTransactionStatus.PendingReference })).status,
      transient: replyForError(new TransientInfrastructureError('lock_timeout')).status,
    };
    expect(statuses).toEqual({ invalidPayload: 400, idempotencyConflict: 409, businessRejection: 422, acceptedPending: 202, transient: 503 });
    expect(new Set(Object.values(statuses)).size).toBe(5);
  });

  test('errors: 400 details, 404, 409 for both conflicts, 503 + Retry-After and retryable flag, 500 for the rest', () => {
    const invalid = replyForError(new InvalidPayloadError([{ field: 'money.amount', message: 'bad' }]));
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_PAYLOAD', retryable: false, details: [{ field: 'money.amount' }] } });
    expect(replyForError(new WalletNotFoundError('w')).status).toBe(404);
    expect(replyForError(new TransactionNotFoundError()).status).toBe(404);
    expect(replyForError(new WalletAlreadyExistsError('p', 'BRL')).status).toBe(409);
    expect(replyForError(new IdempotencyConflictError()).status).toBe(409);

    const transient = replyForError(new TransientInfrastructureError('connection'));
    expect(transient.status).toBe(503);
    expect(transient.headers?.['Retry-After']).toBe('5');
    expect(transient.body).toMatchObject({ error: { retryable: true } });
    expect(replyForError(new TransientInfrastructureError('deadlock')).headers?.['Retry-After']).toBe('1');

    expect(replyForError(new PermanentInfrastructureError('x')).status).toBe(500);
    expect(replyForError(new Error('who knows')).status).toBe(500);
    expect(JSON.stringify(replyForError(new Error('secret internals')).body)).not.toContain('secret internals');
  });
});

describe('database error classification', () => {
  test('lock timeout / deadlock / serialization / network -> transient (retry)', () => {
    expect((classifyDbError({ code: '55P03' }) as TransientInfrastructureError).reason).toBe('lock_timeout');
    expect((classifyDbError({ code: '40P01' }) as TransientInfrastructureError).reason).toBe('deadlock');
    expect((classifyDbError({ code: '40001' }) as TransientInfrastructureError).reason).toBe('serialization');
    expect((classifyDbError({ code: '08006' }) as TransientInfrastructureError).reason).toBe('connection');
    expect((classifyDbError(new Error('connect ECONNREFUSED 127.0.0.1:5432')) as TransientInfrastructureError).reason).toBe('connection');
  });

  test('integrity / data / syntax errors -> permanent; ApplicationErrors pass through; wrapped driver errors are unwrapped', () => {
    expect(classifyDbError({ code: '23514', constraint: 'ck_wallets_balance_non_negative' })).toBeInstanceOf(PermanentInfrastructureError);
    expect(classifyDbError({ code: '22P02' })).toBeInstanceOf(PermanentInfrastructureError);
    expect(classifyDbError({ code: '42P01' })).toBeInstanceOf(PermanentInfrastructureError);
    const known = new WalletNotFoundError('w');
    expect(classifyDbError(known)).toBe(known);
    expect(classifyDbError({ message: 'wrapped', cause: { code: '40P01' } })).toBeInstanceOf(TransientInfrastructureError);
  });
});
