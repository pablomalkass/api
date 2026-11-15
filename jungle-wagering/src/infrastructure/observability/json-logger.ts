import type { LogFields, Logger } from '../../application/observability';

/** Keys whose values are financial data or full payloads. They are never written to logs. */
const REDACTED_KEYS = new Set([
  'money',
  'amount',
  'balance',
  'balancebefore',
  'balanceafter',
  'initialbalance',
  'storedbalance',
  'calculatedbalance',
  'difference',
  'payload',
  'body',
  'data',
  'authorization',
  'password',
  'secret',
  'token',
]);

const MAX_DEPTH = 4;

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(inner, depth + 1);
  }
  return result;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One JSON object per line on stdout. Structured fields (correlationId, messageId, transactionId, walletId,
 * providerId, ...) are first-class; monetary values and payloads are redacted by key.
 */
export class JsonLogger implements Logger {
  constructor(
    private readonly options: {
      level?: LogLevel;
      service?: string;
      write?: (line: string) => void;
      now?: () => Date;
    } = {},
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }

  private log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (ORDER[level] < ORDER[this.options.level ?? 'info']) return;
    const record = {
      level,
      time: (this.options.now?.() ?? new Date()).toISOString(),
      service: this.options.service ?? 'wagering',
      msg: message,
      ...(redact(fields) as Record<string, unknown>),
    };
    (this.options.write ?? ((line: string) => process.stdout.write(`${line}\n`)))(JSON.stringify(record));
  }
}
