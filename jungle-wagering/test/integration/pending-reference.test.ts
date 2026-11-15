import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { PendingReferenceWorker } from '../../src/application/workers/pending-reference-worker';
import { connect, resetDatabase } from '../helpers/db';
import {
  TestClock,
  balanceOf,
  createStack,
  ledgerCount,
  openWallet,
  outboxTypes,
  submit,
  type PublishedEvent,
  type Stack,
} from '../helpers/fixtures';
import { findInconsistentWallets } from '../helpers/invariants';

let sql: SQL;
let clock: TestClock;
let stack: Stack;

const POLICY = { maxAttempts: 3, ttlMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 4_000 };

beforeAll(() => {
  sql = connect(30);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await resetDatabase(sql);
  clock = new TestClock(new Date('2026-07-29T15:00:00.000Z'));
  // random() = 0.5 -> jitter factor exactly 1.0, so delays are exactly 1s, 2s, 4s...
  stack = createStack(sql, { clock, random: () => 0.5, config: { referenceRetry: POLICY } });
});

const rowOf = async (externalId: string) =>
  ((await sql.unsafe(
    'SELECT status, failure_code, reference_attempts, reference_next_attempt_at, reference_transaction_id FROM wager_transactions WHERE external_transaction_id = $1',
    [externalId],
  )) as unknown as {
    status: string;
    failure_code: string | null;
    reference_attempts: number;
    reference_next_attempt_at: Date | null;
    reference_transaction_id: string | null;
  }[])[0]!;

describe('references that arrive out of order', () => {
  test('REFUND before its BET: parked as PENDING_REFERENCE (no money moves), then applied once the BET arrives', async () => {
    const wallet = await openWallet(stack, '100.00');

    const early = await submit(stack, wallet, 'REFUND', '30.00', {
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(early.result.status).toBe('PENDING_REFERENCE');
    expect(early.result.idempotentReplay).toBe(false);
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect(await outboxTypes(sql, wallet.id)).toContain('WagerTransactionPendingReference');

    // The referenced BET finally arrives. Processing it wakes its dependents immediately.
    await submit(stack, wallet, 'BET', '30.00', { externalTransactionId: 'bet-1' });
    expect(await balanceOf(sql, wallet.id)).toBe('70.00');

    expect(await stack.pendingWorker.drainOnce()).toBe(1);

    const refund = await rowOf('refund-1');
    expect(refund.status).toBe('PROCESSED');
    expect(refund.reference_transaction_id).not.toBeNull();
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(3); // opening, bet, refund
    expect(await findInconsistentWallets(sql)).toEqual([]);

    // The provider's retry of the early REFUND returns the ORIGINAL (now final) outcome, not a second credit.
    const replay = await stack.useCase.submit(early.command, { correlationId: 'replay' });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe('PROCESSED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('ROLLBACK before the WIN it reverts: parked, then debits once the WIN exists', async () => {
    const wallet = await openWallet(stack, '100.00');
    const rollback = await submit(stack, wallet, 'ROLLBACK', '40.00', {
      externalTransactionId: 'rb-1',
      referenceExternalTransactionId: 'win-1',
    });
    expect(rollback.result.status).toBe('PENDING_REFERENCE');

    await submit(stack, wallet, 'WIN', '40.00', { externalTransactionId: 'win-1' });
    expect(await balanceOf(sql, wallet.id)).toBe('140.00');
    await stack.pendingWorker.drainOnce();

    expect((await rowOf('rb-1')).status).toBe('PROCESSED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('a WIN that arrives before its BET also waits for the reference', async () => {
    const wallet = await openWallet(stack, '100.00');
    const win = await submit(stack, wallet, 'WIN', '50.00', { externalTransactionId: 'win-9', referenceExternalTransactionId: 'bet-9' });
    expect(win.result.status).toBe('PENDING_REFERENCE');
    await submit(stack, wallet, 'BET', '10.00', { externalTransactionId: 'bet-9' });
    await stack.pendingWorker.drainOnce();
    expect(await balanceOf(sql, wallet.id)).toBe('140.00');
  });

  test('the PendingReference event is emitted ONCE, not on every retry', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'REFUND', '5.00', { externalTransactionId: 'r', referenceExternalTransactionId: 'missing' });
    for (let i = 0; i < 2; i++) {
      clock.advance(10_000);
      await stack.pendingWorker.drainOnce();
    }
    const types = await outboxTypes(sql, wallet.id);
    expect(types.filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
  });

  test('a reference that was itself REJECTED makes the dependent REJECTED (nothing to reverse), never a credit', async () => {
    const wallet = await openWallet(stack, '10.00');
    const refund = await submit(stack, wallet, 'REFUND', '80.00', { externalTransactionId: 'refund-x', referenceExternalTransactionId: 'bet-x' });
    expect(refund.result.status).toBe('PENDING_REFERENCE');

    const bet = await submit(stack, wallet, 'BET', '80.00', { externalTransactionId: 'bet-x' });
    expect(bet.result.status).toBe('REJECTED'); // insufficient funds
    await stack.pendingWorker.drainOnce();

    const row = await rowOf('refund-x');
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_REJECTED');
    expect(await balanceOf(sql, wallet.id)).toBe('10.00');
  });

  test('two REFUNDs parked on the same BET: exactly one is applied', async () => {
    const wallet = await openWallet(stack, '100.00');
    for (const id of ['refund-a', 'refund-b']) {
      await submit(stack, wallet, 'REFUND', '20.00', { externalTransactionId: id, referenceExternalTransactionId: 'bet-z' });
    }
    await submit(stack, wallet, 'BET', '20.00', { externalTransactionId: 'bet-z' });
    await stack.pendingWorker.drainOnce();

    const statuses = [(await rowOf('refund-a')).status, (await rowOf('refund-b')).status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = (await rowOf('refund-a')).status === 'REJECTED' ? 'refund-a' : 'refund-b';
    expect((await rowOf(rejected)).failure_code).toBe('ALREADY_REVERSED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00'); // refunded exactly once
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});

describe('backoff, retry budget and expiry', () => {
  test('the worker respects the exponential backoff: nothing is processed before it is due', async () => {
    const wallet = await openWallet(stack, '100.00');
    const t0 = clock.now().getTime();
    await submit(stack, wallet, 'REFUND', '5.00', { externalTransactionId: 'r1', referenceExternalTransactionId: 'never' });

    let row = await rowOf('r1');
    expect(row.reference_attempts).toBe(1);
    expect(row.reference_next_attempt_at!.getTime() - t0).toBe(1_000); // base * 2^0

    expect(await stack.pendingWorker.drainOnce()).toBe(0); // not due yet
    clock.advance(999);
    expect(await stack.pendingWorker.drainOnce()).toBe(0);
    clock.advance(1);
    expect(await stack.pendingWorker.drainOnce()).toBe(1); // due, still missing -> rescheduled

    row = await rowOf('r1');
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.reference_attempts).toBe(2);
    expect(row.reference_next_attempt_at!.getTime() - clock.now().getTime()).toBe(2_000); // base * 2^1

    clock.advance(2_000);
    await stack.pendingWorker.drainOnce();
    row = await rowOf('r1');
    expect(row.reference_attempts).toBe(3);
    expect(row.reference_next_attempt_at!.getTime() - clock.now().getTime()).toBe(4_000); // base * 2^2, == cap
  });

  test('retry budget exhausted: REJECTED/REFERENCE_NOT_FOUND, terminal, auditable, event published, money untouched', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'REFUND', '5.00', { externalTransactionId: 'lost', referenceExternalTransactionId: 'never-arrives' });

    for (let i = 0; i < 3; i++) {
      clock.advance(5_000);
      await stack.pendingWorker.drainOnce();
    }

    const row = await rowOf('lost');
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect(await outboxTypes(sql, wallet.id)).toContain('WagerTransactionRejected');

    // Terminal: the worker never touches it again and a late BET changes nothing for it.
    clock.advance(60 * 60_000);
    expect(await stack.pendingWorker.drainOnce()).toBe(0);
    await submit(stack, wallet, 'BET', '5.00', { externalTransactionId: 'never-arrives' });
    await stack.pendingWorker.drainOnce();
    expect((await rowOf('lost')).status).toBe('REJECTED');

    const events: PublishedEvent[] = [];
    await stack.publisher(events).publishBatch();
    const rejected = events.find((e) => e.eventType === 'WagerTransactionRejected');
    expect(JSON.parse(rejected!.body).data.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(stack.metrics.counter('pending_reference_attempts_total', { result: 'rejected' })).toBe(1);
  });

  test('TTL expiry rejects even when attempts remain', async () => {
    const generous = createStack(sql, {
      clock,
      random: () => 0.5,
      config: { referenceRetry: { maxAttempts: 100, ttlMs: 10_000, baseDelayMs: 1_000, maxDelayMs: 1_000 } },
    });
    const wallet = await openWallet(generous, '100.00');
    await submit(generous, wallet, 'ROLLBACK', '5.00', { externalTransactionId: 'ttl', referenceExternalTransactionId: 'ghost' });

    clock.advance(5_000);
    await generous.pendingWorker.drainOnce();
    expect((await rowOf('ttl')).status).toBe('PENDING_REFERENCE');

    clock.advance(6_000); // past the 10s TTL
    await generous.pendingWorker.drainOnce();
    const row = await rowOf('ttl');
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
  });

  test('a reference that arrives at the very last moment is still applied (the final evaluation looks it up first)', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'REFUND', '10.00', { externalTransactionId: 'late', referenceExternalTransactionId: 'bet-late' });
    for (let i = 0; i < 2; i++) {
      clock.advance(5_000);
      await stack.pendingWorker.drainOnce();
    }
    expect((await rowOf('late')).reference_attempts).toBe(3); // budget spent

    await submit(stack, wallet, 'BET', '10.00', { externalTransactionId: 'bet-late' });
    clock.advance(5_000);
    await stack.pendingWorker.drainOnce();
    expect((await rowOf('late')).status).toBe('PROCESSED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });
});

describe('several workers at once (multi-instance safe, no leader election)', () => {
  test('5 workers draining 30 parked transactions process each exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(stack, '1000.00')));
    for (const [w, wallet] of wallets.entries()) {
      for (let i = 0; i < 5; i++) {
        await submit(stack, wallet, 'REFUND', '10.00', {
          externalTransactionId: `refund-${w}-${i}`,
          referenceExternalTransactionId: `bet-${w}-${i}`,
        });
      }
    }
    for (const [w, wallet] of wallets.entries()) {
      for (let i = 0; i < 5; i++) await submit(stack, wallet, 'BET', '10.00', { externalTransactionId: `bet-${w}-${i}` });
    }

    const workers = Array.from({ length: 5 }, () => new PendingReferenceWorker(stack.useCase));
    const processed = await Promise.all(workers.map((worker) => worker.drainOnce()));
    expect(processed.reduce((a, b) => a + b, 0)).toBe(30);

    const rows = (await sql.unsafe("SELECT status, count(*) AS c FROM wager_transactions WHERE kind = 'REFUND' GROUP BY status")) as unknown as {
      status: string;
      c: string;
    }[];
    expect(rows).toEqual([{ status: 'PROCESSED', c: '30' }]);
    for (const wallet of wallets) expect(await balanceOf(sql, wallet.id)).toBe('1000.00');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('the background loop picks parked transactions up on its own', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'REFUND', '10.00', { externalTransactionId: 'bg', referenceExternalTransactionId: 'bet-bg' });
    await submit(stack, wallet, 'BET', '10.00', { externalTransactionId: 'bet-bg' });

    const worker = new PendingReferenceWorker(stack.useCase, { idleMs: 10 });
    worker.start();
    for (let i = 0; i < 100 && (await rowOf('bg')).status !== 'PROCESSED'; i++) await new Promise((r) => setTimeout(r, 20));
    await worker.stop();

    expect((await rowOf('bg')).status).toBe('PROCESSED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });
});
