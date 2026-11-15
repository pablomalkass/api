import { describe, expect, test } from 'bun:test';
import { InvalidPayloadError } from '../../src/application/errors';
import { parseOptionalInt, parseUuidParam } from '../../src/application/parsers';
import { loadConfig } from '../../src/config';
import { checkReadiness } from '../../src/interfaces/http/readiness';

describe('configuration', () => {
  test('defaults are sane and every role is on', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config.port).toBe(3000);
    expect(config.roles).toEqual({ consumer: true, outboxPublisher: true, pendingReference: true });
    expect(config.queues.transactions).toBe('wager-transactions.fifo');
    expect(config.referenceRetry.maxAttempts).toBe(10);
    expect(config.aws.endpoint).toBeUndefined();
  });

  test('reads overrides, including LocalStack endpoint and per-role switches', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '8080',
      SQS_ENDPOINT: 'http://localstack:4566',
      ROLE_CONSUMER: 'false',
      REFERENCE_MAX_ATTEMPTS: '4',
    });
    expect(config.port).toBe(8080);
    expect(config.aws.endpoint).toBe('http://localstack:4566');
    expect(config.roles.consumer).toBe(false);
    expect(config.referenceRetry.maxAttempts).toBe(4);
  });

  test('fails fast and lists EVERY problem at once', () => {
    let message = '';
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud', ROLE_CONSUMER: 'maybe', DB_POOL_MIN: '9', DB_POOL_MAX: '3' });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const problem of ['DATABASE_URL is required', 'PORT must be', 'LOG_LEVEL must be', 'ROLE_CONSUMER must be', 'DB_POOL_MIN must not exceed']) {
      expect(message).toContain(problem);
    }
  });

  test('the application retry limit must stay below the queue RedrivePolicy safety net', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', CONSUMER_MAX_RECEIVE_COUNT: '10' })).toThrow('RedrivePolicy');
  });
});

describe('route/query parameter parsing', () => {
  test('uuids are validated before they can reach SQL, and normalised to lower case', () => {
    expect(parseUuidParam('0192F291-27DD-7D3F-8071-5F8685DEEF37', 'walletId')).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    for (const bad of ['', 'not-a-uuid', "1' OR '1'='1", undefined, 42]) {
      expect(() => parseUuidParam(bad, 'walletId')).toThrow(InvalidPayloadError);
    }
  });

  test('limit must be a plain positive integer', () => {
    expect(parseOptionalInt(undefined, 'limit')).toBeUndefined();
    expect(parseOptionalInt('50', 'limit')).toBe(50);
    for (const bad of ['-1', '1.5', 'abc', '1e3', '9999999', ['1']]) {
      expect(() => parseOptionalInt(bad, 'limit')).toThrow(InvalidPayloadError);
    }
  });
});

describe('readiness', () => {
  test('ready only when PostgreSQL AND SQS both answer', async () => {
    const ok = async () => {};
    expect(await checkReadiness({ postgres: ok, sqs: ok })).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
    expect(await checkReadiness({ postgres: ok, sqs: () => Promise.reject(new Error('down')) })).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });

  test('a hanging dependency is reported down instead of hanging the probe', async () => {
    const hang = () => new Promise<void>(() => {});
    const startedAt = performance.now();
    const report = await checkReadiness({ postgres: hang }, 50);
    expect(report.checks.postgres).toBe('down');
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
