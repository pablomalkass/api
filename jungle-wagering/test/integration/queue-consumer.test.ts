import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { TransientInfrastructureError } from '../../src/application/errors';
import type { TxContext, UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { WagerQueueConsumer, type ConsumerHooks } from '../../src/application/workers/queue-consumer';
import { connect, resetDatabase } from '../helpers/db';
import {
  SystemClock,
  UuidGenerator,
  balanceOf,
  createStack,
  ledgerCount,
  openWallet,
  txBody,
  type Stack,
  type TxBody,
  type WalletRef,
} from '../helpers/fixtures';
import { InMemoryFifoQueue } from '../helpers/in-memory-queue';
import { findInconsistentWallets } from '../helpers/invariants';

let sql: SQL;
let stack: Stack;

beforeAll(() => {
  sql = connect(20);
  stack = createStack(sql);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await resetDatabase(sql);
});

/** Builds the exact wire format of the README (section 10). */
function envelope(wallet: WalletRef, kind: string, amount: string, overrides: Partial<TxBody> = {}, messageId = `msg-${randomUUID()}`) {
  const { body, key } = txBody(wallet, kind, amount, overrides);
  return {
    messageId,
    body: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key },
    }),
    walletId: wallet.id,
  };
}

function queues() {
  const dlq = new InMemoryFifoQueue({ visibilityTimeoutMs: 60_000 });
  const queue = new InMemoryFifoQueue({ visibilityTimeoutMs: 60_000, deadLetterQueue: dlq, maxReceiveCount: 10 });
  return { queue, dlq };
}

function consumerFor(
  q: { queue: InMemoryFifoQueue; dlq: InMemoryFifoQueue },
  options: { useCase?: ProcessWagerTransactionUseCase; hooks?: ConsumerHooks; maxReceiveCount?: number; consumerName?: string } = {},
) {
  return new WagerQueueConsumer({
    queue: q.queue,
    deadLetterQueue: q.dlq,
    useCase: options.useCase ?? stack.useCase,
    metrics: stack.metrics,
    hooks: options.hooks,
    config: {
      consumerName: options.consumerName ?? 'test-consumer',
      maxReceiveCount: options.maxReceiveCount ?? 3,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      waitTimeSeconds: 0,
      idleBackoffMs: 5,
      pollers: 1,
      shutdownTimeoutMs: 5_000,
    },
  });
}

async function enqueue(queue: InMemoryFifoQueue, message: ReturnType<typeof envelope>, deduplicationId = message.messageId) {
  await queue.send(message.body, { groupId: message.walletId, deduplicationId });
}

const inboxRows = async () =>
  (await sql.unsafe('SELECT message_id, processed_at FROM inbox_messages')) as unknown as { message_id: string; processed_at: Date | null }[];

describe('SQS consumer: happy path', () => {
  test('applies the transaction through the same use case, acks after the commit and records the inbox', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const message = envelope(wallet, 'BET', '30.00');
    await enqueue(q.queue, message);

    expect(await consumerFor(q).pollOnce()).toBe(1);

    expect(await balanceOf(sql, wallet.id)).toBe('70.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2); // OPENING credit + the BET debit
    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(0);
    const inbox = await inboxRows();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.message_id).toBe(message.messageId);
    expect(inbox[0]?.processed_at).not.toBeNull();
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('messages of one wallet are processed strictly in order (BET, then its REFUND)', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const bet = envelope(wallet, 'BET', '40.00', { externalTransactionId: 'bet-1' });
    const refund = envelope(wallet, 'REFUND', '40.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' });
    await enqueue(q.queue, bet);
    await enqueue(q.queue, refund);

    const consumer = consumerFor(q);
    await consumer.pollOnce();

    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    const statuses = (await sql.unsafe('SELECT kind, status FROM wager_transactions WHERE kind IN (\'BET\',\'REFUND\') ORDER BY created_at')) as unknown as {
      kind: string;
      status: string;
    }[];
    expect(statuses).toEqual([
      { kind: 'BET', status: 'PROCESSED' },
      { kind: 'REFUND', status: 'PROCESSED' },
    ]);
  });
});

describe('SQS consumer: crash between commit and ack', () => {
  test('the worker dies AFTER the commit and BEFORE the ack: the redelivery is deduplicated, the debit happens once', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const message = envelope(wallet, 'BET', '30.00');
    await enqueue(q.queue, message);

    let crashed = false;
    const dying = consumerFor(q, {
      hooks: {
        afterCommitBeforeAck: () => {
          if (!crashed) {
            crashed = true;
            throw new Error('simulated crash after commit, before ack');
          }
        },
      },
    });

    await dying.pollOnce();
    // Committed, not acked: the message is still in the queue, the money already moved.
    expect(crashed).toBe(true);
    expect(q.queue.size).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('70.00');

    // Visibility timeout elapses -> SQS redelivers to ANOTHER consumer instance.
    await q.queue.changeVisibility('m-1:1', 0);
    const survivor = consumerFor(q);
    await survivor.pollOnce();

    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(0);
    expect(await balanceOf(sql, wallet.id)).toBe('70.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
    expect(stack.metrics.counter('wager_duplicates_total', { source: 'sqs', type: 'message' })).toBe(1);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('the ack itself failing is harmless: the redelivery hits the inbox', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '25.00'));

    const realDelete = q.queue.delete.bind(q.queue);
    let failures = 1;
    q.queue.delete = async (handle: string) => {
      if (failures-- > 0) throw new Error('SQS unavailable');
      return realDelete(handle);
    };

    const consumer = consumerFor(q);
    await consumer.pollOnce();
    expect(q.queue.size).toBe(1);
    await q.queue.changeVisibility('m-1:1', 0);
    await consumer.pollOnce();

    expect(q.queue.size).toBe(0);
    expect(await balanceOf(sql, wallet.id)).toBe('75.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
  });

  test('the same messageId delivered twice (queue-level duplicate) never debits twice, even with two consumers racing', async () => {
    const wallet = await openWallet(stack, '100.00');
    const message = envelope(wallet, 'BET', '60.00');

    // Two independent queues stand in for a duplicate delivery of the SAME message to two instances.
    const q1 = queues();
    const q2 = queues();
    await enqueue(q1.queue, message);
    await enqueue(q2.queue, message);

    await Promise.all([consumerFor(q1).pollOnce(), consumerFor(q2).pollOnce()]);

    expect(await balanceOf(sql, wallet.id)).toBe('40.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
    expect(q1.queue.size + q2.queue.size).toBe(0);
    expect(await inboxRows()).toHaveLength(1);
  });

  test('the inbox is per consumer: the same messageId under another consumerName is a different message', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const message = envelope(wallet, 'BET', '10.00');
    await enqueue(q.queue, message);
    await consumerFor(q, { consumerName: 'consumer-a' }).pollOnce();
    // Another consumer has its own inbox namespace; the business key still protects the money.
    await enqueue(q.queue, message, `${message.messageId}:again`);
    await consumerFor(q, { consumerName: 'consumer-b' }).pollOnce();

    expect(await balanceOf(sql, wallet.id)).toBe('90.00');
    expect(await inboxRows()).toHaveLength(2);
    expect(q.dlq.size).toBe(0);
  });
});

describe('SQS consumer: error taxonomy', () => {
  test('a business rejection is a COMMITTED outcome: REJECTED is persisted, the message is acked, nothing reaches the DLQ', async () => {
    const wallet = await openWallet(stack, '10.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '80.00'));

    await consumerFor(q).pollOnce();

    const rows = (await sql.unsafe("SELECT status, failure_code FROM wager_transactions WHERE kind = 'BET'")) as unknown as {
      status: string;
      failure_code: string;
    }[];
    expect(rows).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }]);
    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(0);
    expect(await balanceOf(sql, wallet.id)).toBe('10.00');
  });

  test('a permanently invalid message goes straight to the DLQ with its reason, and is removed from the queue', async () => {
    const q = queues();
    await q.queue.send('{"messageId":"bad-1","type":"WagerTransactionRequested"', { groupId: 'g', deduplicationId: 'bad-1' });
    await q.queue.send(
      JSON.stringify({ messageId: 'bad-2', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { kind: 'OPENING' } }),
      { groupId: 'g2', deduplicationId: 'bad-2' },
    );

    const consumer = consumerFor(q);
    await consumer.pollOnce();

    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(2);
    expect(q.dlq.attributesOf(0).reason).toBe('INVALID_MESSAGE');
    expect(stack.metrics.counter('wager_dlq_messages_total', { reason: 'INVALID_MESSAGE' })).toBe(2);
  });

  test('OPENING cannot be injected through the queue', async () => {
    const wallet = await openWallet(stack, '5.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'OPENING', '1000000.00'));
    await consumerFor(q).pollOnce();

    expect(q.dlq.size).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('5.00');
  });

  test('a message for an unknown wallet is permanent: DLQ, not an endless retry loop', async () => {
    const q = queues();
    const ghost: WalletRef = { id: randomUUID(), playerId: randomUUID() };
    await enqueue(q.queue, envelope(ghost, 'BET', '1.00'));
    await consumerFor(q).pollOnce();

    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(1);
    expect(q.dlq.attributesOf(0).reason).toBe('WALLET_NOT_FOUND');
  });

  test('the same messageId with a DIFFERENT payload is a poison message, not a silent duplicate', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const first = envelope(wallet, 'BET', '10.00', {}, 'msg-fixed');
    const tampered = envelope(wallet, 'BET', '99.00', {}, 'msg-fixed');
    await enqueue(q.queue, first);
    await consumerFor(q).pollOnce();
    await enqueue(q.queue, tampered, 'dedup-other');
    await consumerFor(q).pollOnce();

    expect(await balanceOf(sql, wallet.id)).toBe('90.00');
    expect(q.dlq.size).toBe(1);
    expect(q.dlq.attributesOf(0).reason).toBe('INBOX_PAYLOAD_CONFLICT');
  });

  test('an idempotency-key conflict arriving by queue is permanent', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    const first = envelope(wallet, 'BET', '10.00', { externalTransactionId: 'same-tx' });
    const conflicting = envelope(wallet, 'BET', '20.00', { externalTransactionId: 'same-tx' });
    await enqueue(q.queue, first);
    await enqueue(q.queue, conflicting);
    await consumerFor(q).pollOnce();

    expect(await balanceOf(sql, wallet.id)).toBe('90.00');
    expect(q.dlq.attributesOf(0).reason).toBe('IDEMPOTENCY_CONFLICT');
  });
});

/** A unit of work that fails with a TRANSIENT error a number of times, then behaves normally. */
class FlakyUnitOfWork implements UnitOfWork {
  public attempts = 0;
  constructor(
    private readonly inner: UnitOfWork,
    private readonly failures: number,
  ) {}
  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    this.attempts++;
    if (this.attempts <= this.failures) throw new TransientInfrastructureError('connection');
    return this.inner.run(work);
  }
}

function flakyUseCase(failures: number) {
  const uow = new FlakyUnitOfWork(stack.uow, failures);
  const useCase = new ProcessWagerTransactionUseCase({ uow, clock: new SystemClock(), ids: new UuidGenerator() });
  return { uow, useCase };
}

describe('SQS consumer: transient failures, backoff and DLQ', () => {
  test('a transient failure is NOT acked and not dead-lettered: it is retried and finally applied exactly once', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '40.00'));
    const { uow, useCase } = flakyUseCase(2);
    const consumer = consumerFor(q, { useCase });

    await consumer.pollOnce(); // fails (1)
    expect(q.queue.size).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    await consumer.pollOnce(); // fails (2)
    expect(q.queue.size).toBe(1);
    await consumer.pollOnce(); // succeeds

    expect(uow.attempts).toBe(3);
    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(0);
    expect(await balanceOf(sql, wallet.id)).toBe('60.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
    expect(stack.metrics.counter('wager_retries_total', { reason: 'queue' })).toBe(2);
  });

  test('the retry visibility follows exponential backoff and honours the cap', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '1.00'));
    const seen: number[] = [];
    const realChange = q.queue.changeVisibility.bind(q.queue);
    q.queue.changeVisibility = async (handle: string, seconds: number) => {
      seen.push(seconds);
      return realChange(handle, 0); // do not actually wait
    };
    const { useCase } = flakyUseCase(4);
    const consumer = new WagerQueueConsumer({
      queue: q.queue,
      deadLetterQueue: q.dlq,
      useCase,
      config: { consumerName: 'backoff', maxReceiveCount: 10, retryBaseSeconds: 2, retryMaxSeconds: 10, waitTimeSeconds: 0, pollers: 1 },
    });

    for (let i = 0; i < 5; i++) await consumer.pollOnce();

    expect(seen).toEqual([2, 4, 8, 10]); // 2 * 2^(n-1), capped at 10
    expect(await balanceOf(sql, wallet.id)).toBe('99.00');
  });

  test('after maxReceiveCount attempts the message is dead-lettered and nothing was applied', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '40.00'));
    const { useCase } = flakyUseCase(Number.MAX_SAFE_INTEGER);
    const consumer = consumerFor(q, { useCase, maxReceiveCount: 3 });

    for (let i = 0; i < 3; i++) await consumer.pollOnce();

    expect(q.queue.size).toBe(0);
    expect(q.dlq.size).toBe(1);
    expect(q.dlq.attributesOf(0).reason).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
  });

  test('a failure in the middle of the SQL transaction rolls back inbox, wager, wallet, ledger and outbox together', async () => {
    const wallet = await openWallet(stack, '100.00');
    const q = queues();
    await enqueue(q.queue, envelope(wallet, 'BET', '40.00'));

    const failingUow: UnitOfWork = {
      run: (work) =>
        stack.uow.run(async (db) => {
          const wrapped: TxContext = {
            ...db,
            outbox: {
              ...db.outbox,
              enqueue: async () => {
                throw new TransientInfrastructureError('connection');
              },
            },
          };
          return work(wrapped);
        }),
    };
    const useCase = new ProcessWagerTransactionUseCase({ uow: failingUow, clock: new SystemClock(), ids: new UuidGenerator() });
    await consumerFor(q, { useCase }).pollOnce();

    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect(await inboxRows()).toHaveLength(0);
    const txs = (await sql.unsafe("SELECT count(*) AS c FROM wager_transactions WHERE kind = 'BET'")) as unknown as { c: string }[];
    expect(Number(txs[0]?.c)).toBe(0);
    expect(q.queue.size).toBe(1); // not acked: it will be retried
  });
});

describe('SQS consumer: graceful shutdown (SIGTERM)', () => {
  test('stop() lets the in-flight message finish and ack; the untouched ones go back to the queue immediately', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const q = queues();
    const first = envelope(wallet, 'BET', '10.00');
    const second = envelope(wallet, 'BET', '10.00');
    const third = envelope(wallet, 'BET', '10.00');
    await enqueue(q.queue, first);
    await enqueue(q.queue, second);
    await enqueue(q.queue, third);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));

    const consumer = consumerFor(q, {
      hooks: {
        afterCommitBeforeAck: async () => {
          started();
          await gate; // the first message is committed and "still being finished" when SIGTERM arrives
        },
      },
    });
    consumer.start();
    await inFlight;

    let stopped = false;
    const stopping = consumer.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false); // stop() waits for the in-flight work
    release();
    await stopping;

    // The in-flight message was acked after its commit; the other two were NOT processed and are visible again.
    expect(await balanceOf(sql, wallet.id)).toBe('990.00');
    expect(q.queue.size).toBe(2);

    // Their visibility was reset to 0 on shutdown, so a new instance picks them up IMMEDIATELY (no 60s timeout)
    // and the totals are exact.
    const next = consumerFor(q);
    await next.pollOnce();
    expect(q.queue.size).toBe(0);
    expect(await balanceOf(sql, wallet.id)).toBe('970.00');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});
