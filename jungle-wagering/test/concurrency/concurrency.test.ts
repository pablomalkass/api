import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransientInfrastructureError } from '../../src/application/errors';
import { ProcessWagerTransactionUseCase, type SubmitResult } from '../../src/application/process-wager-transaction';
import { BunUnitOfWork } from '../helpers/bun-unit-of-work';
import { DATABASE_URL, connect, resetDatabase } from '../helpers/db';
import {
  SystemClock,
  UuidGenerator,
  balanceOf,
  command,
  createStack,
  ledgerCount,
  openWallet,
  outboxTypes,
  submit,
  txBody,
  uniqueId,
  type Stack,
  type TxBody,
} from '../helpers/fixtures';
import { findInconsistentWallets } from '../helpers/invariants';

let sql: SQL;
let stack: Stack;

beforeAll(() => {
  sql = connect(30);
  stack = createStack(sql);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await resetDatabase(sql);
});

const ctx = () => ({ correlationId: uniqueId('corr') });
const count = <T>(items: T[], predicate: (item: T) => boolean) => items.filter(predicate).length;

async function countRows(table: string, where: string, params: unknown[] = []): Promise<number> {
  const rows = (await sql.unsafe(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)) as { c: string }[];
  return Number(rows[0]?.c);
}

describe('the same BET sent 50 times in parallel', () => {
  test('produces ONE debit, 49 replays, one ledger entry and one set of events', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const cmd = command(wallet, 'BET', '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => stack.useCase.submit(cmd, ctx())));

    expect(count(results, (r) => !r.idempotentReplay)).toBe(1);
    expect(count(results, (r) => r.idempotentReplay)).toBe(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '975.00')).toBe(true);

    expect(await balanceOf(sql, wallet.id)).toBe('975.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2); // opening + exactly one debit
    expect(await countRows('wager_transactions', 'wallet_id = $1 AND kind = $2', [wallet.id, 'BET'])).toBe(1);
    expect((await outboxTypes(sql, wallet.id)).slice(2)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('also holds for a REJECTED request: 50 parallel copies create ONE rejection record and no debit', async () => {
    const wallet = await openWallet(stack, '10.00');
    const cmd = command(wallet, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => stack.useCase.submit(cmd, ctx())));
    expect(count(results, (r) => !r.idempotentReplay)).toBe(1);
    expect(results.every((r) => r.status === 'REJECTED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id])).toBe(1);
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect((await outboxTypes(sql, wallet.id)).filter((t) => t === 'WagerTransactionRejected').length).toBe(1);
  });

  test('a duplicate is answered even while another transaction holds the wallet lock (the gate never touches the lock)', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const cmd = command(wallet, 'BET', '25.00');
    await stack.useCase.submit(cmd, ctx());

    const held = holdWalletLock(sql, wallet.id);
    await held.acquired;
    try {
      const started = performance.now();
      const replay = await stack.useCase.submit(cmd, ctx());
      expect(replay.idempotentReplay).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      held.release();
      await held.done;
    }
  });
});

describe('mandatory scenario: balance 100.00, two bets of 80.00 at the same time', () => {
  test('exactly one PROCESSED, one REJECTED for insufficient funds, final balance 20.00, ONE debit entry, no retry duplicates it', async () => {
    const wallet = await openWallet(stack, '100.00');
    const a = command(wallet, 'BET', '80.00');
    const b = command(wallet, 'BET', '80.00');

    const results = await Promise.all([stack.useCase.submit(a, ctx()), stack.useCase.submit(b, ctx())]);

    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(1);
    const rejected = results.filter((r) => r.status === 'REJECTED');
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(sql, wallet.id)).toBe('20.00');
    expect(await countRows('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id])).toBe(1);

    // retries of BOTH (in parallel, several times) never duplicate the debit
    await Promise.all([a, b, a, b, a, b].map((cmd) => stack.useCase.submit(cmd, ctx())));
    expect(await balanceOf(sql, wallet.id)).toBe('20.00');
    expect(await countRows('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id])).toBe(1);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('is not luck: 60 independent repetitions all end the same way', async () => {
    const wallets = await Promise.all(Array.from({ length: 60 }, () => openWallet(stack, '100.00')));
    const outcomes = await Promise.all(
      wallets.map((wallet) =>
        Promise.all([submit(stack, wallet, 'BET', '80.00'), submit(stack, wallet, 'BET', '80.00')]).then((pair) => pair.map((p) => p.result)),
      ),
    );
    for (const [index, pair] of outcomes.entries()) {
      expect(count(pair, (r) => r.status === 'PROCESSED')).toBe(1);
      expect(count(pair, (r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(1);
      expect(await balanceOf(sql, (wallets[index] as { id: string }).id)).toBe('20.00');
    }
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});

describe('hot wallet and parallel wallets', () => {
  test('50 distinct bets of 10.00 against 100.00: exactly 10 win the money, the rest are rejected, never negative', async () => {
    const wallet = await openWallet(stack, '100.00');
    const results = (await Promise.all(Array.from({ length: 50 }, () => submit(stack, wallet, 'BET', '10.00')))).map((r) => r.result);

    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(10);
    expect(count(results, (r) => r.status === 'REJECTED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(40);
    expect(await balanceOf(sql, wallet.id)).toBe('0.00');
    expect(await countRows('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id])).toBe(10);
    expect((await stack.queries.getWallet(wallet.id)).version).toBe(11);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('mixed BET / WIN / LOSS storm: the final balance is exactly what the PROCESSED results imply', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(stack, '200.00')));
    const plan: { wallet: (typeof wallets)[number]; kind: string; amount: string }[] = [];
    for (let i = 0; i < 300; i++) {
      const wallet = wallets[i % wallets.length] as (typeof wallets)[number];
      const kind = ['BET', 'BET', 'WIN', 'LOSS'][i % 4] as string;
      plan.push({ wallet, kind, amount: `${5 + (i % 7) * 3}.${(i * 7) % 100}`.replace(/\.(\d)$/, '.0$1') });
    }
    const outcomes = await Promise.all(
      plan.map(async (item) => ({ item, result: (await submit(stack, item.wallet, item.kind, item.amount)).result })),
    );

    for (const wallet of wallets) {
      const mine = outcomes.filter((o) => o.item.wallet.id === wallet.id && o.result.status === 'PROCESSED');
      let expected = 20_000n; // minor units
      for (const { item } of mine) {
        const [whole, cents] = item.amount.split('.') as [string, string];
        const minor = BigInt(whole) * 100n + BigInt(cents);
        if (item.kind === 'BET') expected -= minor;
        if (item.kind === 'WIN') expected += minor;
      }
      const stored = (await balanceOf(sql, wallet.id)).replace('.', '');
      expect(BigInt(stored)).toBe(expected);
    }
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('different wallets are processed in parallel and never wait for each other (no global lock)', async () => {
    const [slow, fast] = await Promise.all([openWallet(stack, '100.00'), openWallet(stack, '100.00')]);
    const held = holdWalletLock(sql, slow.id);
    await held.acquired;
    try {
      const started = performance.now();
      const results = await Promise.all(Array.from({ length: 20 }, () => submit(stack, fast, 'BET', '1.00')));
      expect(results.every((r) => r.result.status === 'PROCESSED')).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await balanceOf(sql, fast.id)).toBe('80.00');
    } finally {
      held.release();
      await held.done;
    }
  });

  test('40 wallets x 5 concurrent bets each: every wallet ends exactly right', async () => {
    const wallets = await Promise.all(Array.from({ length: 40 }, () => openWallet(stack, '1000.00')));
    await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 5 }, () => submit(stack, wallet, 'BET', '10.00'))));
    for (const wallet of wallets) expect(await balanceOf(sql, wallet.id)).toBe('950.00');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});

describe('reversal races', () => {
  test('20 concurrent REFUNDs of the same BET: exactly one is applied, 19 are ALREADY_REVERSED', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    const results = (
      await Promise.all(
        Array.from({ length: 20 }, () =>
          submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId }),
        ),
      )
    ).map((r) => r.result);
    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(1);
    expect(count(results, (r) => r.failureCode === 'ALREADY_REVERSED')).toBe(19);
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('a REFUND racing a ROLLBACK of the same BET: only one of them credits the player', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    const ref = { referenceExternalTransactionId: bet.command.externalTransactionId };
    const results = (
      await Promise.all([
        ...Array.from({ length: 10 }, () => submit(stack, wallet, 'REFUND', '25.00', ref)),
        ...Array.from({ length: 10 }, () => submit(stack, wallet, 'ROLLBACK', '25.00', ref)),
      ])
    ).map((r) => r.result);
    expect(count(results, (r) => r.status === 'PROCESSED')).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });
});

describe('lock contention is explicit and safe', () => {
  test('when the wallet lock cannot be obtained in time the caller gets a TRANSIENT error and nothing is persisted', async () => {
    const wallet = await openWallet(stack, '100.00');
    const impatient = new ProcessWagerTransactionUseCase({
      uow: new BunUnitOfWork(sql, { lockTimeoutMs: 300 }),
      clock: new SystemClock(),
      ids: new UuidGenerator(),
      metrics: stack.metrics,
    });
    const cmd = command(wallet, 'BET', '10.00');

    const held = holdWalletLock(sql, wallet.id);
    await held.acquired;
    try {
      const error = await impatient.submit(cmd, ctx()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).reason).toBe('lock_timeout');
    } finally {
      held.release();
      await held.done;
    }

    expect(await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id])).toBe(0);
    expect(stack.metrics.counter('wallet_lock_conflicts_total', { outcome: 'timeout' })).toBe(1);

    const retried = await impatient.submit(cmd, ctx());
    expect(retried).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
  });

  test('contention shows up in the lock-wait metrics', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const local = createStack(sql, { config: { lockContentionThresholdMs: 0 } });
    await Promise.all(Array.from({ length: 20 }, () => submit(local, wallet, 'BET', '1.00')));
    expect(local.metrics.observations.get('wallet_lock_wait_seconds')?.length).toBe(20);
    expect(local.metrics.counter('wallet_lock_conflicts_total', { outcome: 'waited' })).toBe(20);
  });
});

// --- real OS processes ------------------------------------------------------------------------------------------

const RUNNER = join(import.meta.dir, '../helpers/instance-runner.ts');
const planDir = mkdtempSync(join(tmpdir(), 'wagering-plans-'));

type RunnerResult = { status: string; replay: boolean; failureCode?: string } | { error: string };

function spawnInstance(commands: { body: TxBody; key: string }[], concurrency = 8) {
  const planPath = join(planDir, `${randomUUID()}.json`);
  writeFileSync(planPath, JSON.stringify({ databaseUrl: DATABASE_URL, concurrency, commands }));
  const proc = Bun.spawn(['bun', RUNNER, planPath], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const results = (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      return JSON.parse(out) as RunnerResult[];
    } catch {
      throw new Error(`instance produced no result. stdout=${out.slice(0, 300)} stderr=${err.slice(0, 600)}`);
    }
  })();
  return { proc, results };
}

describe('three real application instances (separate OS processes) against one database', () => {
  test('the SAME 30 bets sent by 3 processes at once are applied exactly once', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const commands = Array.from({ length: 30 }, () => txBody(wallet, 'BET', '10.00'));

    const runs = await Promise.all([spawnInstance(commands), spawnInstance(commands), spawnInstance(commands)].map((i) => i.results));

    const flat = runs.flat();
    expect(flat.every((r) => !('error' in r))).toBe(true);
    expect(count(flat, (r) => 'status' in r && r.status === 'PROCESSED' && !r.replay)).toBe(30);
    expect(count(flat, (r) => 'status' in r && r.replay)).toBe(60);
    expect(await balanceOf(sql, wallet.id)).toBe('700.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(31);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  }, 60_000);

  test('3 processes fighting for one hot wallet: 60 distinct bets of 5.00 against 100.00 -> exactly 20 succeed', async () => {
    const wallet = await openWallet(stack, '100.00');
    const slices = [0, 1, 2].map(() => Array.from({ length: 20 }, () => txBody(wallet, 'BET', '5.00')));

    const runs = await Promise.all(slices.map((commands) => spawnInstance(commands).results));
    const flat = runs.flat();

    expect(flat.every((r) => !('error' in r))).toBe(true);
    expect(count(flat, (r) => 'status' in r && r.status === 'PROCESSED')).toBe(20);
    expect(count(flat, (r) => 'status' in r && r.status === 'REJECTED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(40);
    expect(await balanceOf(sql, wallet.id)).toBe('0.00');
    expect(await countRows('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id])).toBe(20);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  }, 60_000);

  test('3 processes, 12 wallets, the classic 80/80 scenario on every wallet at once', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet(stack, '100.00')));
    const perProcess = [0, 1, 2].map(() => wallets.map((wallet) => txBody(wallet, 'BET', '80.00')));

    const runs = await Promise.all(perProcess.map((commands) => spawnInstance(commands, 12).results));
    expect(runs.flat().every((r) => !('error' in r))).toBe(true);

    for (const wallet of wallets) {
      expect(await balanceOf(sql, wallet.id)).toBe('20.00');
      expect(await countRows('wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id])).toBe(1);
    }
    expect(await findInconsistentWallets(sql)).toEqual([]);
  }, 60_000);
});

describe('restart with proof of final consistency', () => {
  test('instances SIGKILLed mid-flight leave a consistent database, and a restart completes every transaction exactly once', async () => {
    const wallet = await openWallet(stack, '10000.00');
    const commands = Array.from({ length: 300 }, () => txBody(wallet, 'BET', '10.00'));

    const doomed = [spawnInstance(commands, 8), spawnInstance(commands, 8), spawnInstance(commands, 8)];
    for (const instance of doomed) void instance.results.catch(() => undefined);

    // wait until the instances are demonstrably mid-flight, then kill them without any chance to clean up
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id])) < 25) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const instance of doomed) instance.proc.kill('SIGKILL');
    await Promise.all(doomed.map((instance) => instance.proc.exited));

    const midway = await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id]);
    expect(midway).toBeGreaterThan(0);
    // whatever had been committed is fully consistent: no half-applied transaction, no orphan ledger entry
    expect(await findInconsistentWallets(sql)).toEqual([]);
    expect(await countRows('wager_transactions', "status = 'PENDING'")).toBe(0);

    // restart: a brand-new fleet replays the very same traffic
    const restarted = await Promise.all([spawnInstance(commands, 8), spawnInstance(commands, 8), spawnInstance(commands, 8)].map((i) => i.results));
    expect(restarted.flat().every((r) => !('error' in r))).toBe(true);

    expect(await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET'", [wallet.id])).toBe(300);
    expect(await countRows('wager_transactions', "wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'", [wallet.id])).toBe(300);
    expect(await balanceOf(sql, wallet.id)).toBe('7000.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(301);
    expect(await findInconsistentWallets(sql)).toEqual([]);
    // one Processed + one BalanceChanged event per applied bet (plus the opening pair): nothing lost, nothing doubled
    const types = await outboxTypes(sql, wallet.id);
    expect(types.filter((t) => t === 'WagerTransactionProcessed').length).toBe(301);
    expect(types.filter((t) => t === 'WalletBalanceChanged').length).toBe(301);
  }, 120_000);
});

/** Holds the wallet row lock from ANOTHER connection until released (to provoke and observe contention). */
function holdWalletLock(connection: SQL, walletId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let acquire!: () => void;
  const acquired = new Promise<void>((resolve) => (acquire = resolve));
  const done = connection.begin(async (tx) => {
    await tx.unsafe('SELECT id FROM wallets WHERE id = $1 FOR NO KEY UPDATE', [walletId]);
    acquire();
    await released;
  });
  return { acquired, release, done };
}

export type { SubmitResult };
