/**
 * Load test of the processing core: ProcessWagerTransactionUseCase + repositories + a REAL PostgreSQL, with the
 * outbox publisher running concurrently. It does NOT go through HTTP/NestJS or a real SQS (see ARCHITECTURE.md > Load test).
 *
 *   bun run test:load
 *   CONCURRENCY=64 DURATION_S=30 HOT_RATIO=1 bun run test:load      # every request fights for one wallet
 *
 * Env: DATABASE_URL, DURATION_S=15, CONCURRENCY=32, WALLETS=200, HOT_RATIO=0.2, DUP_RATIO=0.1, OUT=load-test-results.json
 * DESTRUCTIVE: the schema is dropped and recreated. It refuses to run unless the database name ends in "_test"
 * (or LOAD_TEST_ALLOW_RESET=1).
 */
import { SQL } from 'bun';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { TransientInfrastructureError } from '../src/application/errors';
import { parseSubmitCommand, type SubmitWagerCommand } from '../src/application/parsers';
import { replyForSubmit } from '../src/interfaces/http/http-mapping';
import { DATABASE_URL, resetDatabase } from '../test/helpers/db';
import { createStack, openWallet, uniqueId, type WalletRef } from '../test/helpers/fixtures';
import { findInconsistentWallets } from '../test/helpers/invariants';

const num = (key: string, fallback: number) => (process.env[key] ? Number(process.env[key]) : fallback);
const DURATION_S = num('DURATION_S', 15);
const CONCURRENCY = num('CONCURRENCY', 32);
const WALLETS = num('WALLETS', 200);
const HOT_RATIO = num('HOT_RATIO', 0.2);
const DUP_RATIO = num('DUP_RATIO', 0.1);
const OUT = process.env.OUT ?? 'load-test-results.json';

const dbName = new URL(DATABASE_URL).pathname.slice(1);
if (!dbName.endsWith('_test') && process.env.LOAD_TEST_ALLOW_RESET !== '1') {
  console.error(`refusing to reset database "${dbName}": the name must end in _test (or set LOAD_TEST_ALLOW_RESET=1)`);
  process.exit(2);
}

const percentile = (sorted: number[], p: number) => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number) : 0);
const round = (n: number, digits = 2) => Number(n.toFixed(digits));

const sql = new SQL({ url: DATABASE_URL, max: CONCURRENCY + 10 });
await resetDatabase(sql);
const stack = createStack(sql, { config: { lockContentionThresholdMs: 25 } });

console.log(`preparing ${WALLETS} wallets...`);
const wallets: WalletRef[] = [];
for (let i = 0; i < WALLETS; i += 25) {
  const batch = await Promise.all(Array.from({ length: Math.min(25, WALLETS - i) }, () => openWallet(stack, '1000000.00')));
  wallets.push(...batch);
}
const hot = wallets[0] as WalletRef;

const latencies: number[] = [];
const statuses = new Map<string, number>();
const bump = (key: string) => statuses.set(key, (statuses.get(key) ?? 0) + 1);

// outbox publisher in the background + lag sampling
const published = { count: 0 };
const lagSamples: number[] = [];
let publishing = true;
const publisher = new (await import('../src/application/workers/outbox-publisher')).OutboxPublisher({
  uow: stack.uow,
  clock: stack.clock,
  metrics: stack.metrics,
  config: { batchSize: 100 },
  publisher: { publish: async () => void published.count++ },
});
const publishLoop = (async () => {
  while (publishing) {
    const n = await publisher.publishBatch();
    if (n === 0) await new Promise((r) => setTimeout(r, 20));
  }
})();
const lagLoop = (async () => {
  while (publishing) {
    lagSamples.push(await stack.uow.run((db) => db.outbox.lagSeconds(new Date())));
    await new Promise((r) => setTimeout(r, 250));
  }
})();

const deadline = performance.now() + DURATION_S * 1000;
let total = 0;

async function worker(): Promise<void> {
  const recent: SubmitWagerCommand[] = [];
  const lastBetByWallet = new Map<string, string>();
  while (performance.now() < deadline) {
    let cmd: SubmitWagerCommand;
    if (recent.length > 0 && Math.random() < DUP_RATIO) {
      cmd = recent[Math.floor(Math.random() * recent.length)] as SubmitWagerCommand; // provider retry: same key, same payload
    } else {
      const wallet = Math.random() < HOT_RATIO ? hot : (wallets[1 + Math.floor(Math.random() * (wallets.length - 1))] ?? hot);
      const roll = Math.random();
      const externalTransactionId = uniqueId('lt');
      const base = { providerId: 'load', externalTransactionId, playerId: wallet.playerId, walletId: wallet.id, roundId: 'r1', gameId: 'g1' };
      const lastBet = lastBetByWallet.get(wallet.id);
      let body: Record<string, unknown>;
      if (roll < 0.1) {
        body = { ...base, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
      } else if (roll < 0.2 && lastBet) {
        body = { ...base, kind: 'WIN', money: { amount: '4.00', currency: 'BRL' }, referenceExternalTransactionId: lastBet };
      } else {
        body = { ...base, kind: 'BET', money: { amount: (1 + Math.floor(Math.random() * 400) / 100).toFixed(2), currency: 'BRL' } };
        lastBetByWallet.set(wallet.id, externalTransactionId);
      }
      cmd = parseSubmitCommand(body, `load:${externalTransactionId}`);
      recent.push(cmd);
      if (recent.length > 20) recent.shift();
    }

    const startedAt = performance.now();
    try {
      const result = await stack.useCase.submit(cmd, { correlationId: uniqueId('c') });
      latencies.push(performance.now() - startedAt);
      bump(String(replyForSubmit(result).status));
    } catch (error) {
      latencies.push(performance.now() - startedAt);
      bump(error instanceof TransientInfrastructureError ? '503' : '500');
    }
    total++;
  }
}

console.log(`running: ${CONCURRENCY} workers for ${DURATION_S}s (hot ratio ${HOT_RATIO}, duplicate ratio ${DUP_RATIO})...`);
const startedAt = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const elapsedS = (performance.now() - startedAt) / 1000;

// drain the outbox and measure how long it takes to catch up after the load stops
const drainStartedAt = performance.now();
while ((await sql.unsafe('SELECT count(*) AS c FROM outbox_messages WHERE published_at IS NULL') as unknown as { c: string }[])[0]?.c !== '0') {
  await new Promise((r) => setTimeout(r, 50));
}
const drainMs = performance.now() - drainStartedAt;
publishing = false;
await Promise.all([publishLoop, lagLoop]);

// invariants
const inconsistent = await findInconsistentWallets(sql);
const counts = (await sql.unsafe(`
  SELECT
    (SELECT count(*) FROM wager_transactions WHERE status = 'PROCESSED' AND kind <> 'LOSS')::int AS ledger_expected,
    (SELECT count(*) FROM wallet_ledger_entries)::int AS ledger_actual,
    (SELECT count(*) FROM wallets WHERE balance < 0)::int AS negative_wallets,
    (SELECT count(*) FROM wager_transactions WHERE status IN ('PENDING','PENDING_REFERENCE'))::int AS stuck_pending
`)) as unknown as { ledger_expected: number; ledger_actual: number; negative_wallets: number; stuck_pending: number }[];
const invariant = counts[0]!;

latencies.sort((a, b) => a - b);
const m = stack.metrics;
const errors = (statuses.get('500') ?? 0) + (statuses.get('503') ?? 0);
const lockWaits = (m.observations.get('wallet_lock_wait_seconds') ?? []).sort((a, b) => a - b);
lagSamples.sort((a, b) => a - b);

const report = {
  environment: {
    note: 'sandbox VM, PostgreSQL and the load generator share the same machine: indicative, NOT a capacity benchmark',
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    memoryMb: Math.round(os.totalmem() / 1024 / 1024),
    bun: Bun.version,
    postgres: ((await sql.unsafe('SHOW server_version')) as unknown as { server_version: string }[])[0]?.server_version,
    path: 'use case + repositories + PostgreSQL (no HTTP, no SQS network)',
  },
  methodology: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS, hotRatio: HOT_RATIO, duplicateRatio: DUP_RATIO, mix: '~70% BET, ~10% LOSS, ~10% WIN (referenced), plus duplicate resends' },
  results: {
    requests: total,
    throughputPerSecond: round(total / elapsedS, 1),
    latencyMs: { p50: round(percentile(latencies, 50)), p95: round(percentile(latencies, 95)), p99: round(percentile(latencies, 99)), max: round(latencies[latencies.length - 1] ?? 0) },
    statuses: Object.fromEntries([...statuses.entries()].sort()),
    errorRate: round(errors / Math.max(1, total), 4),
    duplicatesDetected: m.counter('wager_duplicates_total', { source: 'http', type: 'idempotency' }),
    concurrencyConflicts: {
      lockWaited: m.counter('wallet_lock_conflicts_total', { outcome: 'waited' }),
      lockTimeouts: m.counter('wallet_lock_conflicts_total', { outcome: 'timeout' }),
      deadlockRetries: m.counter('wager_retries_total', { reason: 'deadlock' }),
      lockWaitMs: { p50: round(percentile(lockWaits, 50) * 1000), p99: round(percentile(lockWaits, 99) * 1000), max: round((lockWaits[lockWaits.length - 1] ?? 0) * 1000) },
    },
    outbox: { eventsPublished: published.count, lagSecondsP95: round(percentile(lagSamples, 95), 3), lagSecondsMax: round(lagSamples[lagSamples.length - 1] ?? 0, 3), drainAfterLoadMs: round(drainMs, 0) },
  },
  invariants: {
    walletsDivergingFromLedger: inconsistent.length,
    negativeBalances: invariant.negative_wallets,
    ledgerEntriesExpected: invariant.ledger_expected,
    ledgerEntriesActual: invariant.ledger_actual,
    ledgerMatchesProcessedTransactions: invariant.ledger_expected === invariant.ledger_actual,
    stuckPending: invariant.stuck_pending,
  },
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
await sql.close();

const ok =
  inconsistent.length === 0 && invariant.negative_wallets === 0 && report.invariants.ledgerMatchesProcessedTransactions && invariant.stuck_pending === 0;
if (!ok) {
  console.error('INVARIANT VIOLATION under load');
  process.exit(1);
}
