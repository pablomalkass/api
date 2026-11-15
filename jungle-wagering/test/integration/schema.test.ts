import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { connect, migrate, resetDatabase } from '../helpers/db';

let sql: SQL;
beforeAll(async () => {
  sql = connect(5);
  await resetDatabase(sql);
});
afterAll(async () => {
  await sql.close();
});

const NOW = '2026-11-15T12:00:00Z';

async function expectViolation(promise: Promise<unknown>, pattern: RegExp | string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(String((error as Error).message)).toMatch(pattern);
    return;
  }
  throw new Error(`expected a database error matching ${String(pattern)}`);
}

async function insertWallet(balance = '0.00', player = randomUUID(), currency = 'BRL'): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [id, player, currency, balance, NOW],
  );
  return id;
}

interface TxOverrides {
  kind?: string;
  status?: string;
  provider?: string;
  external?: string;
  key?: string;
  amount?: string;
  reference?: string | null;
  referenceId?: string | null;
  failureCode?: string | null;
  observed?: string | null;
  processedAt?: string | null;
  next?: string | null;
  deadline?: string | null;
}

async function insertTx(walletId: string, o: TxOverrides = {}): Promise<string> {
  const id = randomUUID();
  const external = o.external ?? `ext-${id}`;
  await sql.unsafe(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, failure_code,
        observed_balance, reference_next_attempt_at, reference_deadline_at, created_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'p','r','g',$7,$8,'BRL',$9,$10,$11,$12,$13,$14::timestamptz,$15::timestamptz,$16::timestamptz,$17::timestamptz)`,
    [
      id,
      o.provider ?? 'provider-a',
      external,
      o.key ?? `${o.provider ?? 'provider-a'}:${external}`,
      'a'.repeat(64),
      walletId,
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.status ?? 'PENDING',
      o.reference ?? null,
      o.referenceId ?? null,
      o.failureCode ?? null,
      o.observed ?? null,
      o.next ?? null,
      o.deadline ?? null,
      NOW,
      o.processedAt ?? null,
    ],
  );
  return id;
}

async function insertLedger(
  walletId: string,
  transactionId: string,
  over: { version?: number; direction?: string; amount?: string; before?: string; after?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      walletId,
      transactionId,
      over.version ?? 2,
      over.direction ?? 'CREDIT',
      over.amount ?? '10.00',
      over.before ?? '0.00',
      over.after ?? '10.00',
      NOW,
    ],
  );
  return id;
}

describe('migrations are versioned and reversible', () => {
  test('down removes everything, up restores it, and the cycle is repeatable', async () => {
    const tables = async () =>
      (await sql.unsafe("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")) as {
        tablename: string;
      }[];
    const before = (await tables()).map((t) => t.tablename);
    expect(before).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);

    await migrate(sql, 'down');
    expect(await tables()).toEqual([]);
    const leftovers = (await sql.unsafe(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname IN ('ledger_forbid_mutation','wager_tx_guard','wallet_assert_ledger_consistent')`,
    )) as unknown[];
    expect(leftovers.length).toBe(0);

    await migrate(sql, 'up');
    await migrate(sql, 'down');
    await migrate(sql, 'up');
    expect((await tables()).map((t) => t.tablename)).toEqual(before);
  });
});

describe('wallets', () => {
  beforeEach(async () => {
    await resetDatabase(sql);
  });

  test('balance can never be negative', async () => {
    await expectViolation(insertWallet('-0.01'), /ck_wallets_balance_non_negative/);
  });

  test('balance is stored with exact scale 2 (no float rounding)', async () => {
    // wallet + OPENING transaction + ledger entry in ONE transaction: the only way money can enter a wallet
    const id = randomUUID();
    const openingTx = randomUUID();
    await sql.begin(async (t) => {
      await t.unsafe(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,'p','BRL',0.30,1,$2,$2)`,
        [id, NOW],
      );
      await t.unsafe(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
            kind, amount, currency, status, observed_balance, created_at, processed_at)
         VALUES ($1,'internal',$2,$2,$3,$4,'p','opening','opening','OPENING',0.30,'BRL','PROCESSED',0.30,$5,$5)`,
        [openingTx, `opening:${id}`, 'a'.repeat(64), id, NOW],
      );
      await t.unsafe(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, created_at)
         VALUES ($1,$2,$3,1,'CREDIT',0.30,0.00,0.30,$4)`,
        [randomUUID(), id, openingTx, NOW],
      );
    });
    const [row] = (await sql.unsafe('SELECT balance FROM wallets WHERE id = $1', [id])) as { balance: string }[];
    expect(row?.balance).toBe('0.30');
    const [sum] = (await sql.unsafe('SELECT (0.10::numeric(19,2) + 0.20::numeric(19,2))::text AS s')) as { s: string }[];
    expect(sum?.s).toBe('0.30');
  });

  test('at most one wallet per (playerId, currency); another currency is fine', async () => {
    const player = randomUUID();
    await insertWallet('0.00', player, 'BRL');
    await expectViolation(insertWallet('0.00', player, 'BRL'), /uq_wallets_player_currency/);
    await insertWallet('0.00', player, 'USD');
  });

  test('currency must look like an ISO-4217 code; version must be >= 1', async () => {
    await expectViolation(insertWallet('0.00', randomUUID(), 'brl'), /currency/);
    const id = await insertWallet('0.00');
    await expectViolation(sql.unsafe('UPDATE wallets SET version = 0 WHERE id = $1', [id]), /ck_wallets_version_positive/);
  });

  test('a balance change with no ledger entry cannot commit (deferred consistency trigger)', async () => {
    const id = await insertWallet('0.00');
    await expectViolation(
      sql.unsafe('UPDATE wallets SET balance = 50.00, version = 2 WHERE id = $1', [id]),
      /diverges from its ledger|no ledger entries/,
    );
    const [row] = (await sql.unsafe('SELECT balance FROM wallets WHERE id = $1', [id])) as { balance: string }[];
    expect(row?.balance).toBe('0.00');
  });

  test('a wallet created with money but no opening ledger entry cannot commit', async () => {
    await expectViolation(insertWallet('100.00'), /no ledger entries/);
  });
});

describe('wager_transactions', () => {
  let wallet: string;
  beforeEach(async () => {
    await resetDatabase(sql);
    wallet = await insertWallet('0.00');
  });

  test('(provider, externalTransactionId) is unique', async () => {
    await insertTx(wallet, { external: 'dup', key: 'k1' });
    await expectViolation(insertTx(wallet, { external: 'dup', key: 'k2' }), /uq_wager_tx_provider_external/);
  });

  test('the idempotency key is unique', async () => {
    await insertTx(wallet, { external: 'a', key: 'same-key' });
    await expectViolation(insertTx(wallet, { external: 'b', key: 'same-key' }), /uq_wager_tx_idempotency_key/);
  });

  test('ON CONFLICT DO NOTHING is race-free: concurrent duplicate inserts create exactly one row', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () =>
        sql.begin(async (tx) => {
          const rows = (await tx.unsafe(
            `INSERT INTO wager_transactions
               (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
             VALUES ($1,'prov','race-ext','prov:race-ext',$2,$3,'p','r','g','BET',1.00,'BRL','PENDING',$4)
             ON CONFLICT DO NOTHING RETURNING id`,
            [randomUUID(), 'b'.repeat(64), wallet, NOW],
          )) as unknown[];
          return rows.length;
        }),
      ),
    );
    expect(attempts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('OPENING is internal only: not under a real provider, and the internal provider carries nothing else', async () => {
    await expectViolation(insertTx(wallet, { kind: 'OPENING', provider: 'provider-a' }), /ck_wager_tx_opening_internal/);
    await expectViolation(insertTx(wallet, { kind: 'BET', provider: 'internal' }), /ck_wager_tx_opening_internal/);
    await insertTx(wallet, { kind: 'OPENING', provider: 'internal' });
  });

  test('REFUND and ROLLBACK require a reference; BET must not have one', async () => {
    await expectViolation(insertTx(wallet, { kind: 'REFUND' }), /ck_wager_tx_reversal_has_reference/);
    await expectViolation(insertTx(wallet, { kind: 'ROLLBACK' }), /ck_wager_tx_reversal_has_reference/);
    await expectViolation(insertTx(wallet, { kind: 'BET', reference: 'x' }), /ck_wager_tx_no_reference_on_bet/);
    await insertTx(wallet, { kind: 'REFUND', reference: 'bet-1' });
  });

  test('amounts are positive, except LOSS which may be zero', async () => {
    await expectViolation(insertTx(wallet, { amount: '0.00' }), /ck_wager_tx_amount/);
    await expectViolation(insertTx(wallet, { kind: 'WIN', amount: '-1.00' }), /ck_wager_tx_amount/);
    await insertTx(wallet, { kind: 'LOSS', amount: '0.00' });
  });

  test('status and kind are closed sets', async () => {
    await expectViolation(insertTx(wallet, { status: 'DONE' }), /ck_wager_tx_status/);
    await expectViolation(insertTx(wallet, { kind: 'CHARGEBACK' }), /ck_wager_tx_kind/);
  });

  test('REJECTED and FAILED carry a failureCode; nothing else may', async () => {
    await expectViolation(
      insertTx(wallet, { status: 'REJECTED', observed: '0.00', processedAt: NOW }),
      /ck_wager_tx_failure_code/,
    );
    await expectViolation(insertTx(wallet, { status: 'PENDING', failureCode: 'X' }), /ck_wager_tx_failure_code/);
    await insertTx(wallet, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', observed: '0.00', processedAt: NOW });
  });

  test('terminal states have processed_at and settled states have the observed balance', async () => {
    await expectViolation(insertTx(wallet, { status: 'PROCESSED', observed: '0.00' }), /ck_wager_tx_terminal_processed_at/);
    await expectViolation(insertTx(wallet, { status: 'PROCESSED', processedAt: NOW }), /ck_wager_tx_settled_has_balance/);
    await insertTx(wallet, { status: 'PROCESSED', observed: '0.00', processedAt: NOW });
  });

  test('PENDING_REFERENCE must carry its retry schedule', async () => {
    await expectViolation(
      insertTx(wallet, { kind: 'REFUND', reference: 'b', status: 'PENDING_REFERENCE' }),
      /ck_wager_tx_pending_reference_schedule/,
    );
    await insertTx(wallet, { kind: 'REFUND', reference: 'b', status: 'PENDING_REFERENCE', next: NOW, deadline: NOW });
  });

  test('a PROCESSED reversal must point at what it reversed', async () => {
    await expectViolation(
      insertTx(wallet, { kind: 'REFUND', reference: 'b', status: 'PROCESSED', observed: '0.00', processedAt: NOW }),
      /ck_wager_tx_processed_reversal_has_reference_id/,
    );
  });

  test('a transaction can be reversed only once, by ANY reversal kind (no double credit)', async () => {
    const bet = await insertTx(wallet, { kind: 'BET', status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    const reversal = (kind: string) =>
      insertTx(wallet, { kind, reference: 'bet', referenceId: bet, status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    await reversal('REFUND');
    await expectViolation(reversal('REFUND'), /uq_wager_tx_one_reversal_per_reference/);
    await expectViolation(reversal('ROLLBACK'), /uq_wager_tx_one_reversal_per_reference/);
  });

  test('a REJECTED reversal does not consume the single reversal slot', async () => {
    const bet = await insertTx(wallet, { kind: 'BET', status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    await insertTx(wallet, {
      kind: 'REFUND',
      reference: 'bet',
      referenceId: bet,
      status: 'REJECTED',
      failureCode: 'REFERENCE_AMOUNT_MISMATCH',
      observed: '0.00',
      processedAt: NOW,
    });
    await insertTx(wallet, { kind: 'REFUND', reference: 'bet', referenceId: bet, status: 'PROCESSED', observed: '0.00', processedAt: NOW });
  });

  test('terminal rows never change again and rows are never deleted', async () => {
    const id = await insertTx(wallet, { status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    await expectViolation(sql.unsafe("UPDATE wager_transactions SET status = 'REJECTED' WHERE id = $1", [id]), /terminal/);
    await expectViolation(sql.unsafe('UPDATE wager_transactions SET game_id = $2 WHERE id = $1', [id, 'x']), /terminal/);
    await expectViolation(sql.unsafe('DELETE FROM wager_transactions WHERE id = $1', [id]), /append-only/);
    await expectViolation(sql.unsafe('TRUNCATE wager_transactions CASCADE'), /append-only/);
  });

  test('non-terminal rows can progress', async () => {
    const id = await insertTx(wallet);
    await sql.unsafe("UPDATE wager_transactions SET status = 'PROCESSED', observed_balance = 0, processed_at = now() WHERE id = $1", [id]);
  });
});

describe('wallet_ledger_entries', () => {
  let wallet: string;
  let tx: string;
  beforeEach(async () => {
    await resetDatabase(sql);
    wallet = await insertWallet('0.00');
    tx = await insertTx(wallet, { kind: 'WIN', status: 'PROCESSED', observed: '0.00', processedAt: NOW });
  });

  /** Inserts a consistent (entry + wallet update) pair in one transaction. */
  async function credit(amount: string, version: number, before: string, after: string, transactionId = tx) {
    await sql.begin(async (t) => {
      await t.unsafe(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, created_at)
         VALUES ($1,$2,$3,$4,'CREDIT',$5,$6,$7,$8)`,
        [randomUUID(), wallet, transactionId, version, amount, before, after, NOW],
      );
      await t.unsafe('UPDATE wallets SET balance = $2, version = $3 WHERE id = $1', [wallet, after, version]);
    });
  }

  test('the arithmetic of every entry is verified by the database', async () => {
    await expectViolation(insertLedger(wallet, tx, { direction: 'CREDIT', amount: '10.00', before: '0.00', after: '11.00' }), /ck_ledger_arithmetic/);
    await expectViolation(insertLedger(wallet, tx, { direction: 'DEBIT', amount: '10.00', before: '20.00', after: '5.00' }), /ck_ledger_arithmetic/);
  });

  test('amounts are positive and balances never negative', async () => {
    await expectViolation(insertLedger(wallet, tx, { amount: '0.00', before: '5.00', after: '5.00' }), /ck_ledger_amount/);
    await expectViolation(insertLedger(wallet, tx, { direction: 'DEBIT', amount: '10.00', before: '5.00', after: '-5.00' }), /ck_ledger_balances/);
  });

  test('direction is a closed set', async () => {
    // values chosen so the arithmetic check (which sorts first) is satisfied and only the direction check can fire
    await expectViolation(
      insertLedger(wallet, tx, { direction: 'SIDEWAYS', amount: '10.00', before: '10.00', after: '0.00' }),
      /ck_ledger_direction/,
    );
  });

  test('a consistent entry plus wallet update commits', async () => {
    await credit('10.00', 2, '0.00', '10.00');
    const [row] = (await sql.unsafe('SELECT balance, version FROM wallets WHERE id = $1', [wallet])) as { balance: string; version: string }[];
    expect(row?.balance).toBe('10.00');
    expect(Number(row?.version)).toBe(2);
  });

  test('at most one entry per wallet per transaction', async () => {
    await credit('10.00', 2, '0.00', '10.00');
    await expectViolation(credit('5.00', 3, '10.00', '15.00'), /uq_ledger_wallet_transaction/);
  });

  test('one entry per wallet version', async () => {
    await credit('10.00', 2, '0.00', '10.00');
    const tx2 = await insertTx(wallet, { kind: 'WIN', status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    await expectViolation(credit('5.00', 2, '10.00', '15.00', tx2), /uq_ledger_wallet_version/);
  });

  test('entries are never updated, deleted or truncated, not even by the table owner', async () => {
    await credit('10.00', 2, '0.00', '10.00');
    await expectViolation(sql.unsafe("UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1", [wallet]), /append-only/);
    await expectViolation(sql.unsafe('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet]), /append-only/);
    await expectViolation(sql.unsafe('TRUNCATE wallet_ledger_entries'), /append-only/);
  });

  test('a wallet cannot drift from its ledger in either direction', async () => {
    await credit('10.00', 2, '0.00', '10.00');
    await expectViolation(
      sql.unsafe('UPDATE wallets SET balance = 999.00, version = 3 WHERE id = $1', [wallet]),
      /diverges from its ledger/,
    );
    // an entry without the matching wallet update is also rejected at commit
    const tx2 = await insertTx(wallet, { kind: 'WIN', status: 'PROCESSED', observed: '0.00', processedAt: NOW });
    await expectViolation(
      sql.begin(async (t) => {
        await t.unsafe(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, created_at)
           VALUES ($1,$2,$3,3,'CREDIT',5.00,10.00,15.00,$4)`,
          [randomUUID(), wallet, tx2, NOW],
        );
        // the wallet is "touched" without applying the entry
        await t.unsafe('UPDATE wallets SET updated_at = now() WHERE id = $1', [wallet]);
      }),
      /diverges from its ledger/,
    );
  });
});

describe('inbox and outbox', () => {
  beforeEach(async () => {
    await resetDatabase(sql);
  });

  test('inbox is unique per (consumer, messageId): the same id under another consumer is a different message', async () => {
    const insert = (consumer: string) =>
      sql.unsafe(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ($1,'m-1',$2,$3)`,
        [consumer, 'c'.repeat(64), NOW],
      );
    await insert('consumer-a');
    await expectViolation(insert('consumer-a'), /inbox_messages_pkey/);
    await insert('consumer-b');
  });

  test('outbox attempts cannot be negative and the unpublished index exists', async () => {
    await expectViolation(
      sql.unsafe(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES ($1,'a','E','{}'::jsonb,$2,-1,$2)`,
        [randomUUID(), NOW],
      ),
      /ck_outbox_attempts/,
    );
    const [index] = (await sql.unsafe("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_outbox_due'")) as { indexdef: string }[];
    expect(index?.indexdef).toContain('published_at IS NULL');
  });
});
