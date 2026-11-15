export type LogFields = Record<string, unknown>;

/** Structured logger port. Implementations must never log full payloads or monetary amounts. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type Labels = Record<string, string>;

export type CounterName =
  | 'wager_transactions_total' // by status, kind
  | 'wager_duplicates_total' // by source (http|sqs|idempotency)
  | 'wager_retries_total' // by reason
  | 'wager_dlq_messages_total' // by reason
  | 'wager_messages_total' // by result
  | 'wallet_lock_conflicts_total' // by outcome (waited|timeout)
  | 'pending_reference_attempts_total' // by result
  | 'outbox_published_total'
  | 'outbox_publish_failures_total'
  | 'reconciliation_divergences_total';

export type GaugeName = 'outbox_lag_seconds' | 'outbox_pending_messages';

export type HistogramName = 'wager_processing_duration_seconds' | 'wallet_lock_wait_seconds';

export interface Metrics {
  increment(name: CounterName, labels?: Labels, by?: number): void;
  gauge(name: GaugeName, value: number): void;
  observe(name: HistogramName, seconds: number, labels?: Labels): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const noopMetrics: Metrics = {
  increment() {},
  gauge() {},
  observe() {},
};

/** In-memory metrics, useful for assertions in tests. */
export class RecordingMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly gauges = new Map<string, number>();
  readonly observations = new Map<string, number[]>();

  increment(name: CounterName, labels: Labels = {}, by = 1): void {
    const key = RecordingMetrics.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: GaugeName, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: HistogramName, seconds: number, labels: Labels = {}): void {
    const key = RecordingMetrics.key(name, labels);
    const list = this.observations.get(key) ?? [];
    list.push(seconds);
    this.observations.set(key, list);
  }

  counter(name: CounterName, labels: Labels = {}): number {
    return this.counters.get(RecordingMetrics.key(name, labels)) ?? 0;
  }

  static key(name: string, labels: Labels): string {
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${labels[k]}"`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }
}
