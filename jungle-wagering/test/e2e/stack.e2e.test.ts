import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

/**
 * END-TO-END against the real stack: `docker compose up --build -d` (PostgreSQL + LocalStack SQS + 3 app instances).
 *
 *   E2E_BASE_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
 *   SQS_ENDPOINT=http://localhost:4566 bun test test/e2e
 *
 * Skipped when E2E_BASE_URLS is not set, so `bun test` stays green on machines without the stack.
 * Everything below goes through HTTP and a REAL SQS: nothing is mocked.
 */
const BASES = (process.env.E2E_BASE_URLS ?? '').split(',').filter(Boolean);
const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const enabled = BASES.length > 0;
const suite = enabled ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let rr = 0;
const base = () => BASES[rr++ % BASES.length] as string;

async function http(path: string, init: { method?: string; body?: unknown; key?: string; url?: string } = {}) {
  const response = await fetch(`${init.url ?? base()}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.key ? { 'idempotency-key': init.key } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined };
}

async function newWallet(initial = '100.00') {
  const playerId = randomUUID();
  const { status, body } = await http('/wallets', { method: 'POST', body: { playerId, initialBalance: { amount: initial, currency: 'BRL' } } });
  expect(status).toBe(201);
  return { id: body.id as string, playerId };
}

function betBody(wallet: { id: string; playerId: string }, kind: string, amount: string, externalTransactionId = `tx-${randomUUID()}`, extra: object = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}
const keyOf = (b: { providerId: string; externalTransactionId: string }) => `${b.providerId}:${b.externalTransactionId}`;

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await sleep(250);
  }
}

suite('stack: HTTP across three instances', () => {
  test('every instance is live and ready (PostgreSQL + SQS reachable)', async () => {
    for (const url of BASES) {
      expect((await http('/health/live', { url })).status).toBe(200);
      const ready = await http('/health/ready', { url });
      expect(ready.status).toBe(200);
      expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
    }
  });

  test('MANDATORY SCENARIO: balance 100.00, two bets of 80.00 hitting different instances at once', async () => {
    const wallet = await newWallet('100.00');
    const [a, b] = [betBody(wallet, 'BET', '80.00'), betBody(wallet, 'BET', '80.00')];
    const results = await Promise.all([
      http('/wagering/transactions', { method: 'POST', body: a, key: keyOf(a), url: BASES[0] }),
      http('/wagering/transactions', { method: 'POST', body: b, key: keyOf(b), url: BASES[BASES.length - 1] }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const rejected = results.find((r) => r.status === 422)!;
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    expect((await http(`/wallets/${wallet.id}`)).body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    const ledger = (await http(`/wallets/${wallet.id}/ledger`)).body.items as { direction: string }[];
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);

    // retries never duplicate the debit
    for (const request of [a, b]) {
      await http('/wagering/transactions', { method: 'POST', body: request, key: keyOf(request) });
    }
    expect((await http(`/wallets/${wallet.id}`)).body.balance.amount).toBe('20.00');
  });

  test('the same bet sent 50 times in parallel across the instances produces ONE debit', async () => {
    const wallet = await newWallet('100.00');
    const body = betBody(wallet, 'BET', '25.00');
    const responses = await Promise.all(Array.from({ length: 50 }, () => http('/wagering/transactions', { method: 'POST', body, key: keyOf(body) })));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await http(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
  });

  test('status codes are distinct: 400 invalid, 409 idempotency conflict, 422 rejection, 202 pending, 404 unknown', async () => {
    const wallet = await newWallet('10.00');

    const invalid = betBody(wallet, 'BET', '1.234');
    expect((await http('/wagering/transactions', { method: 'POST', body: invalid, key: keyOf(invalid) })).status).toBe(400);
    expect((await http('/wagering/transactions', { method: 'POST', body: betBody(wallet, 'BET', '1.00') })).status).toBe(400); // no key

    const first = betBody(wallet, 'BET', '1.00');
    expect((await http('/wagering/transactions', { method: 'POST', body: first, key: keyOf(first) })).status).toBe(200);
    const different = { ...first, money: { amount: '2.00', currency: 'BRL' } };
    expect((await http('/wagering/transactions', { method: 'POST', body: different, key: keyOf(first) })).status).toBe(409);

    const broke = betBody(wallet, 'BET', '999.00');
    expect((await http('/wagering/transactions', { method: 'POST', body: broke, key: keyOf(broke) })).status).toBe(422);

    const early = betBody(wallet, 'REFUND', '5.00', undefined, { referenceExternalTransactionId: `bet-${randomUUID()}` });
    const pending = await http('/wagering/transactions', { method: 'POST', body: early, key: keyOf(early) });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    expect((await http(`/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await http('/wallets/not-a-uuid')).status).toBe(400);
  });

  test('out-of-order REFUND is parked, then applied by a worker once its BET arrives', async () => {
    const wallet = await newWallet('100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = betBody(wallet, 'REFUND', '40.00', undefined, { referenceExternalTransactionId: betId });
    expect((await http('/wagering/transactions', { method: 'POST', body: refund, key: keyOf(refund) })).status).toBe(202);

    const bet = betBody(wallet, 'BET', '40.00', betId);
    expect((await http('/wagering/transactions', { method: 'POST', body: bet, key: keyOf(bet) })).status).toBe(200);

    await eventually(async () => {
      const tx = await http(`/providers/provider-a/wagering/transactions/${refund.externalTransactionId}`);
      return tx.body.status === 'PROCESSED' ? tx.body : undefined;
    });
    expect((await http(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
  });

  test('reconciliation is consistent after all of the above', async () => {
    const wallet = await newWallet('100.00');
    for (let i = 0; i < 5; i++) {
      const body = betBody(wallet, 'BET', '3.00');
      await http('/wagering/transactions', { method: 'POST', body, key: keyOf(body) });
    }
    const result = await http(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ consistent: true, checkedEntries: 6, difference: { amount: '0.00', currency: 'BRL' } });
  });

  test('ledger pagination with an opaque cursor', async () => {
    const wallet = await newWallet('1000.00');
    for (let i = 0; i < 7; i++) {
      const body = betBody(wallet, 'BET', '1.00');
      await http('/wagering/transactions', { method: 'POST', body, key: keyOf(body) });
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = (await http(`/wallets/${wallet.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`)).body;
      seen.push(...page.items.map((i: { walletVersion: number }) => i.walletVersion));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
});

suite('stack: real SQS (LocalStack)', () => {
  const awsConfig = { region: 'us-east-1', endpoint: SQS_ENDPOINT, accessKeyId: 'test', secretAccessKey: 'test' };

  async function queues() {
    // Loaded lazily: the AWS SDK is only needed (and only guaranteed to be installed) when the stack is running.
    const { SqsQueueClient, createSqsClient, resolveQueueUrl } = await import('../../src/infrastructure/messaging/sqs-queue-client');
    const client = createSqsClient(awsConfig);
    return {
      inbound: new SqsQueueClient(client, await resolveQueueUrl(client, 'wager-transactions.fifo', 5)),
      dlq: new SqsQueueClient(client, await resolveQueueUrl(client, 'wager-transactions-dlq.fifo', 5)),
      events: new SqsQueueClient(client, await resolveQueueUrl(client, 'wager-events.fifo', 5)),
    };
  }

  const message = (wallet: { id: string; playerId: string }, kind: string, amount: string, messageId = `msg-${randomUUID()}`, tx = `tx-${randomUUID()}`) => {
    const data = betBody(wallet, kind, amount, tx);
    return {
      messageId,
      tx,
      body: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...data, idempotencyKey: keyOf(data) } }),
    };
  };

  test('a message is consumed, applied once, and its duplicates (same messageId, new dedup id) change nothing', async () => {
    const q = await queues();
    const wallet = await newWallet('100.00');
    const m = message(wallet, 'BET', '30.00');
    for (const attempt of ['a', 'b', 'c']) {
      await q.inbound.send(m.body, { groupId: wallet.id, deduplicationId: `${m.messageId}:${attempt}` });
    }

    await eventually(async () => {
      const tx = await http(`/providers/provider-a/wagering/transactions/${m.tx}`);
      return tx.status === 200 && tx.body.status === 'PROCESSED' ? tx.body : undefined;
    });
    await sleep(3_000); // give the duplicates time to be consumed
    expect((await http(`/wallets/${wallet.id}`)).body.balance.amount).toBe('70.00');
    const ledger = (await http(`/wallets/${wallet.id}/ledger`)).body.items as { direction: string }[];
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('an invalid message lands in the DLQ', async () => {
    const q = await queues();
    const id = `bad-${randomUUID()}`;
    await q.inbound.send(JSON.stringify({ messageId: id, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { kind: 'OPENING' } }), {
      groupId: `g-${id}`,
      deduplicationId: id,
    });
    const found = await eventually(async () => {
      const received = await q.dlq.receive({ maxMessages: 10, waitTimeSeconds: 2 });
      return received.find((m) => m.body.includes(id));
    });
    expect(found).toBeDefined();
  });

  test('committed changes reach the events queue through the outbox', async () => {
    const q = await queues();
    const wallet = await newWallet('100.00');
    const body = betBody(wallet, 'BET', '10.00');
    await http('/wagering/transactions', { method: 'POST', body, key: keyOf(body) });

    const types = new Set<string>();
    await eventually(async () => {
      for (const m of await q.events.receive({ maxMessages: 10, waitTimeSeconds: 2 })) {
        const event = JSON.parse(m.body);
        if (event.aggregateId === wallet.id) types.add(event.eventType);
        await q.events.delete(m.receiptHandle);
      }
      return types.has('WalletBalanceChanged') && types.has('WagerTransactionProcessed') ? true : undefined;
    });
  });
});
