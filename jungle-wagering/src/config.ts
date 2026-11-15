import { DEFAULT_REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from './domain/backoff';

export interface AppConfig {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  database: { url: string; poolMin: number; poolMax: number; lockTimeoutMs: number; statementTimeoutMs: number };
  aws: { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string };
  queues: { transactions: string; transactionsDlq: string; events: string };
  /** Which background roles this process runs. Every role is safe to run on any number of instances. */
  roles: { consumer: boolean; outboxPublisher: boolean; pendingReference: boolean };
  consumer: { maxReceiveCount: number; pollers: number; batchSize: number; waitTimeSeconds: number; shutdownTimeoutMs: number };
  referenceRetry: ReferenceRetryPolicy;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, errors: string[], min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${key} must be an integer >= ${min} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function bool(env: Env, key: string, fallback: boolean, errors: string[]): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
  errors.push(`${key} must be true or false (got "${raw}")`);
  return fallback;
}

/** Reads and validates the environment once, at startup. Fails fast with ALL problems listed. */
export function loadConfig(env: Env = process.env): AppConfig {
  const errors: string[] = [];

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) errors.push('DATABASE_URL is required');

  const level = (env.LOG_LEVEL ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(level)) errors.push(`LOG_LEVEL must be debug|info|warn|error (got "${level}")`);

  const config: AppConfig = {
    port: int(env, 'PORT', 3000, errors, 1),
    logLevel: level as AppConfig['logLevel'],
    database: {
      url: databaseUrl ?? '',
      poolMin: int(env, 'DB_POOL_MIN', 2, errors),
      poolMax: int(env, 'DB_POOL_MAX', 20, errors, 1),
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000, errors, 1),
      statementTimeoutMs: int(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000, errors, 1),
    },
    aws: {
      region: env.AWS_REGION ?? 'us-east-1',
      ...(env.SQS_ENDPOINT ? { endpoint: env.SQS_ENDPOINT } : {}),
      ...(env.AWS_ACCESS_KEY_ID ? { accessKeyId: env.AWS_ACCESS_KEY_ID } : {}),
      ...(env.AWS_SECRET_ACCESS_KEY ? { secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : {}),
    },
    queues: {
      transactions: env.SQS_QUEUE_TRANSACTIONS ?? 'wager-transactions.fifo',
      transactionsDlq: env.SQS_QUEUE_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
      events: env.SQS_QUEUE_EVENTS ?? 'wager-events.fifo',
    },
    roles: {
      consumer: bool(env, 'ROLE_CONSUMER', true, errors),
      outboxPublisher: bool(env, 'ROLE_OUTBOX_PUBLISHER', true, errors),
      pendingReference: bool(env, 'ROLE_PENDING_REFERENCE', true, errors),
    },
    consumer: {
      maxReceiveCount: int(env, 'CONSUMER_MAX_RECEIVE_COUNT', 5, errors, 1),
      pollers: int(env, 'CONSUMER_POLLERS', 2, errors, 1),
      batchSize: int(env, 'CONSUMER_BATCH_SIZE', 10, errors, 1),
      waitTimeSeconds: int(env, 'CONSUMER_WAIT_SECONDS', 20, errors),
      shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 25_000, errors, 1),
    },
    referenceRetry: {
      maxAttempts: int(env, 'REFERENCE_MAX_ATTEMPTS', DEFAULT_REFERENCE_RETRY_POLICY.maxAttempts, errors, 1),
      ttlMs: int(env, 'REFERENCE_TTL_MS', DEFAULT_REFERENCE_RETRY_POLICY.ttlMs, errors, 1),
      baseDelayMs: int(env, 'REFERENCE_BASE_DELAY_MS', DEFAULT_REFERENCE_RETRY_POLICY.baseDelayMs, errors, 1),
      maxDelayMs: int(env, 'REFERENCE_MAX_DELAY_MS', DEFAULT_REFERENCE_RETRY_POLICY.maxDelayMs, errors, 1),
    },
  };

  if (config.database.poolMin > config.database.poolMax) errors.push('DB_POOL_MIN must not exceed DB_POOL_MAX');
  if (config.referenceRetry.baseDelayMs > config.referenceRetry.maxDelayMs) errors.push('REFERENCE_BASE_DELAY_MS must not exceed REFERENCE_MAX_DELAY_MS');
  // The queue's own RedrivePolicy (10 in infra) is only a safety net and must stay above the application limit.
  if (config.consumer.maxReceiveCount >= 10) errors.push('CONSUMER_MAX_RECEIVE_COUNT must stay below the queue RedrivePolicy maxReceiveCount (10)');

  if (errors.length > 0) throw new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}
