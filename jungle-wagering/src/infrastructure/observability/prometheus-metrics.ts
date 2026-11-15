import type { CounterName, GaugeName, HistogramName, Labels, Metrics } from '../../application/observability';

const HELP: Record<CounterName | GaugeName | HistogramName, { type: 'counter' | 'gauge' | 'histogram'; help: string }> = {
  wager_transactions_total: { type: 'counter', help: 'Wager transactions by final status and kind.' },
  wager_duplicates_total: { type: 'counter', help: 'Duplicates detected (idempotent replays and duplicate queue messages).' },
  wager_retries_total: { type: 'counter', help: 'Retries by reason (deadlock, serialization, queue).' },
  wager_dlq_messages_total: { type: 'counter', help: 'Messages moved to the dead-letter queue, by reason.' },
  wager_messages_total: { type: 'counter', help: 'Queue messages handled, by result.' },
  wallet_lock_conflicts_total: { type: 'counter', help: 'Wallet row-lock conflicts (waited for the lock, or timed out).' },
  pending_reference_attempts_total: { type: 'counter', help: 'Out-of-order reference resolution attempts, by result.' },
  outbox_published_total: { type: 'counter', help: 'Outbox events published, by event type.' },
  outbox_publish_failures_total: { type: 'counter', help: 'Outbox publish failures, by event type.' },
  reconciliation_divergences_total: { type: 'counter', help: 'Wallets found diverging from their ledger.' },
  outbox_lag_seconds: { type: 'gauge', help: 'Age in seconds of the oldest unpublished outbox event.' },
  outbox_pending_messages: { type: 'gauge', help: 'Unpublished outbox events.' },
  wager_processing_duration_seconds: { type: 'histogram', help: 'End-to-end processing latency of a wager transaction.' },
  wallet_lock_wait_seconds: { type: 'histogram', help: 'Time spent waiting for the wallet row lock.' },
};

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(String(all[k]))}"`).join(',')}}`;
}

interface Series {
  labels: Labels;
  value: number;
}
interface HistogramSeries {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

/** Dependency-free Prometheus text-format registry. Not shared between processes: every instance exposes its own. */
export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, Series>>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  increment(name: CounterName, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, Series>();
    const key = formatLabels(labels);
    const existing = series.get(key);
    if (existing) existing.value += by;
    else series.set(key, { labels, value: by });
    this.counters.set(name, series);
  }

  gauge(name: GaugeName, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: HistogramName, seconds: number, labels: Labels = {}): void {
    const series = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const key = formatLabels(labels);
    let entry = series.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(BUCKETS.length).fill(0) as number[], sum: 0, count: 0 };
      series.set(key, entry);
    }
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) entry!.counts[index] = (entry!.counts[index] as number) + 1;
    });
    entry.sum += seconds;
    entry.count += 1;
    this.histograms.set(name, series);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, meta] of Object.entries(HELP)) {
      lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} ${meta.type}`);
      if (meta.type === 'counter') {
        for (const series of this.counters.get(name)?.values() ?? []) {
          lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
        }
      } else if (meta.type === 'gauge') {
        const value = this.gauges.get(name);
        if (value !== undefined) lines.push(`${name} ${value}`);
      } else {
        for (const series of this.histograms.get(name)?.values() ?? []) {
          BUCKETS.forEach((bound, index) => {
            lines.push(`${name}_bucket${formatLabels(series.labels, { le: String(bound) })} ${series.counts[index]}`);
          });
          lines.push(`${name}_bucket${formatLabels(series.labels, { le: '+Inf' })} ${series.count}`);
          lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
          lines.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
