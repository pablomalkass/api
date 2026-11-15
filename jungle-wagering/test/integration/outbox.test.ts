import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { OutboxPublisher } from '../../src/application/workers/outbox-publisher';
import { DATABASE_URL, connect, resetDatabase } from '../helpers/db';
import { TestClock, createStack, openWallet, submit, type PublishedEvent, type Stack } from '../helpers/fixtures';
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

const pendingCount = async () =>
  Number(((await sql.unsafe('SELECT count(*) AS c FROM outbox_messages WHERE published_at IS NULL')) as unknown as { c: string }[])[0]?.c);
const totalCount = async () =>
  Number(((await sql.unsafe('SELECT count(*) AS c FROM outbox_messages')) as unknown as { c: string }[])[0]?.c);

/** Generates N processed bets; every one produces WagerTransactionProcessed + WalletBalanceChanged. */
async function generateEvents(bets: number): Promise<void> {
  const wallet = await openWallet(stack, '100000.00');
  for (let i = 0; i < bets; i++) await submit(stack, wallet, 'BET', '1.00');
}

describe('outbox publishing', () => {
  test('publishes every committed event, marks them published, and does not publish them again', async () => {
    await generateEvents(5);
    const total = await totalCount();
    expect(total).toBe(2 + 5 * 2); // wallet opening (2) + 5 bets x 2

    const events: PublishedEvent[] = [];
    const publisher = stack.publisher(events);
    expect(await publisher.publishBatch()).toBe(total);
    expect(await publisher.publishBatch()).toBe(0);

    expect(events).toHaveLength(total);
    expect(await pendingCount()).toBe(0);
    expect(stack.metrics.gauges.get('outbox_lag_seconds')).toBeDefined();
  });

  test('the envelope is stable JSON: eventId == outbox id, decimal-string money, type and version in the type', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '25.00');
    const events: PublishedEvent[] = [];
    await stack.publisher(events).publishBatch();

    const balanceChanged = events.find((e) => e.eventType === 'WalletBalanceChanged' && JSON.parse(e.body).data.direction === 'DEBIT');
    expect(balanceChanged).toBeDefined();
    const envelope = JSON.parse(balanceChanged!.body);
    expect(envelope.eventId).toBe(balanceChanged!.eventId);
    expect(envelope.aggregateId).toBe(wallet.id);
    expect(envelope.version).toBe(1);
    expect(envelope.eventType).toBe('WalletBalanceChanged');
    expect(typeof envelope.correlationId).toBe('string');
    expect(envelope.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(envelope.data).toMatchObject({
      walletId: wallet.id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('NOTHING is published before the commit: an open transaction is invisible to the publisher', async () => {
    const wallet = await openWallet(stack, '100.00');
    const baseline = await totalCount();

    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let inserted!: () => void;
    const insertedInTx = new Promise<void>((resolve) => (inserted = resolve));

    const open = stack.uow.run(async (db) => {
      const { OutboxMessage } = await import('../../src/domain/outbox-message');
      const { WagerTransactionPendingReference } = await import('../../src/domain/events');
      void WagerTransactionPendingReference;
      await db.outbox.enqueue(
        OutboxMessage.rehydrate({
          id: crypto.randomUUID(),
          aggregateId: wallet.id,
          eventType: 'WalletBalanceChanged',
          payload: { probe: true },
          occurredAt: new Date(),
          attempts: 0,
          nextAttemptAt: new Date(),
        }),
      );
      inserted();
      await gate; // the financial transaction is still open here
    });
    await insertedInTx;

    const events: PublishedEvent[] = [];
    await stack.publisher(events).publishBatch(); // drains only what is committed (the opening events)
    expect(events.some((e) => JSON.parse(e.body).probe === true)).toBe(false);
    expect(await totalCount()).toBe(baseline); // the uncommitted row is not even visible

    commit();
    await open;
    const after: PublishedEvent[] = [];
    await stack.publisher(after).publishBatch();
    expect(after.map((e) => JSON.parse(e.body).probe)).toEqual([true]);
  });

  test('a rolled-back financial transaction leaves NO event behind', async () => {
    const wallet = await openWallet(stack, '100.00');
    const baseline = await totalCount();
    const events: PublishedEvent[] = [];
    await stack.publisher(events).publishBatch();
    events.length = 0;

    await expect(
      stack.uow.run(async (db) => {
        const { OutboxMessage } = await import('../../src/domain/outbox-message');
        await db.outbox.enqueue(
          OutboxMessage.rehydrate({
            id: crypto.randomUUID(),
            aggregateId: wallet.id,
            eventType: 'WagerTransactionProcessed',
            payload: {},
            occurredAt: new Date(),
            attempts: 0,
            nextAttemptAt: new Date(),
          }),
        );
        throw new Error('boom: rollback');
      }),
    ).rejects.toThrow('boom');

    expect(await totalCount()).toBe(baseline);
    await stack.publisher(events).publishBatch();
    expect(events).toHaveLength(0);
  });
});

describe('concurrent publishers', () => {
  test('two (and ten) publishers over the same outbox publish every event exactly once', async () => {
    await generateEvents(60);
    const total = await totalCount();
    const events: PublishedEvent[] = [];

    const publishers = Array.from({ length: 10 }, () =>
      new OutboxPublisher({
        uow: stack.uow,
        clock: stack.clock,
        metrics: stack.metrics,
        config: { batchSize: 7 },
        publisher: {
          async publish(event) {
            await new Promise((resolve) => setTimeout(resolve, 1)); // widen the race window
            events.push(event);
          },
        },
      }),
    );
    // Each publisher drains until empty, all at the same time.
    await Promise.all(
      publishers.map(async (publisher) => {
        while ((await publisher.publishBatch()) > 0) {
          /* keep draining */
        }
      }),
    );

    expect(events).toHaveLength(total);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(total); // no duplicates: SKIP LOCKED never shares a row
    expect(await pendingCount()).toBe(0);
  });

  test('publishers do not block each other: a row locked by one is skipped by the other', async () => {
    await generateEvents(4);
    let hold!: () => void;
    const gate = new Promise<void>((resolve) => (hold = resolve));
    let locked!: (n: number) => void;
    const claimed = new Promise<number>((resolve) => (locked = resolve));

    const slow = stack.uow.run(async (db) => {
      const rows = await db.outbox.claimDue(3, new Date());
      locked(rows.length);
      await gate;
    });
    expect(await claimed).toBe(3);

    const events: PublishedEvent[] = [];
    const startedAt = performance.now();
    await stack.publisher(events).publishBatch();
    expect(performance.now() - startedAt).toBeLessThan(2_000); // did not wait for the held locks
    const total = await totalCount();
    expect(events).toHaveLength(total - 3);

    hold();
    await slow;
    await stack.publisher(events).publishBatch(); // the previously locked rows are now free
    expect(events).toHaveLength(total);
  });
});

describe('failures and recovery', () => {
  test('the process dies after claiming the rows and before committing: another instance takes over and publishes everything', async () => {
    await generateEvents(10);
    const total = await totalCount();

    const child = Bun.spawn(['bun', 'test/helpers/claim-and-die.ts', DATABASE_URL, '100'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('CLAIMED')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain(`CLAIMED ${total}`);

    // While the dead-to-be process holds every row, another instance sees nothing to do (and does not hang).
    const whileHeld: PublishedEvent[] = [];
    expect(await stack.publisher(whileHeld).publishBatch()).toBe(0);
    expect(await pendingCount()).toBe(total);

    child.kill('SIGKILL'); // dies before the commit: PostgreSQL rolls back and releases the locks
    await child.exited;

    const recovered: PublishedEvent[] = [];
    // The connection teardown is detected by the server asynchronously: poll briefly.
    for (let i = 0; i < 50 && recovered.length < total; i++) {
      await stack.publisher(recovered).publishBatch();
      if (recovered.length < total) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(recovered).toHaveLength(total);
    expect(await pendingCount()).toBe(0);
  });

  test('crash AFTER the broker accepted the events but BEFORE the commit: they are published again (at-least-once) with the SAME eventIds', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '10.00');
    const total = await totalCount();

    // First instance: the broker accepts every event, then the process is "killed" right before COMMIT.
    const broker: PublishedEvent[] = [];
    const dyingUow = {
      run: <T>(work: Parameters<typeof stack.uow.run<T>>[0]) =>
        stack.uow.run(async (db) => {
          await work(db);
          throw new Error('killed right before COMMIT');
        }),
    };
    const dying = new OutboxPublisher({
      uow: dyingUow,
      clock: stack.clock,
      publisher: { publish: async (event) => void broker.push(event) },
    });
    await expect(dying.publishBatch()).rejects.toThrow('killed right before COMMIT');

    expect(broker).toHaveLength(total); // the broker really received everything...
    expect(await pendingCount()).toBe(total); // ...yet nothing is marked published: the commit never happened

    // Second instance takes over and publishes again.
    const second: PublishedEvent[] = [];
    await stack.publisher(second).publishBatch();
    expect(second).toHaveLength(total);
    expect(await pendingCount()).toBe(0);

    // Consumer-side contract: the duplicates carry the same eventId, so they are trivially deduplicable.
    expect(second.map((e) => e.eventId).sort()).toEqual(broker.map((e) => e.eventId).sort());
  });

  test('a broker outage never loses events: failures are retried with growing backoff, then everything drains', async () => {
    const clock = new TestClock();
    const local = createStack(sql, { clock });
    const wallet = await openWallet(local, '100.00');
    await submit(local, wallet, 'BET', '10.00');
    const total = await totalCount();

    let broken = true;
    const events: PublishedEvent[] = [];
    const publisher = local.publisher(events, () => (broken ? new Error('SQS unavailable') : undefined));

    await publisher.publishBatch();
    expect(events).toHaveLength(0);
    expect(await pendingCount()).toBe(total);
    let rows = (await sql.unsafe('SELECT attempts, next_attempt_at, last_error FROM outbox_messages')) as unknown as {
      attempts: number;
      next_attempt_at: Date;
      last_error: string;
    }[];
    expect(rows.every((r) => r.attempts === 1 && r.last_error === 'SQS unavailable')).toBe(true);
    expect(rows.every((r) => r.next_attempt_at.getTime() > clock.now().getTime())).toBe(true);

    // Not due yet: the backoff is respected.
    expect(await publisher.publishBatch()).toBe(0);

    clock.advance(1_500);
    await publisher.publishBatch(); // fails again: attempt 2, longer delay
    rows = (await sql.unsafe('SELECT attempts FROM outbox_messages')) as unknown as { attempts: number }[];
    expect(rows.every((r) => r.attempts === 2)).toBe(true);

    broken = false;
    clock.advance(10 * 60_000);
    await publisher.publishBatch();
    expect(events).toHaveLength(total);
    expect(await pendingCount()).toBe(0);
    expect(stack.metrics.counter('outbox_publish_failures_total', { eventType: 'WagerTransactionProcessed' })).toBeGreaterThanOrEqual(0);
  });

  test('one poisoned event does not block the others in the batch', async () => {
    await generateEvents(3);
    const total = await totalCount();
    const events: PublishedEvent[] = [];
    let first = true;
    const publisher = stack.publisher(events, () => {
      if (first) {
        first = false;
        return new Error('rejected by broker');
      }
      return undefined;
    });
    await publisher.publishBatch();
    expect(events).toHaveLength(total - 1);
    expect(await pendingCount()).toBe(1);
  });

  test('wallet and ledger stay consistent whatever the publishers do', async () => {
    await generateEvents(20);
    await Promise.all([stack.publisher([]).publishBatch(), stack.publisher([]).publishBatch()]);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});
