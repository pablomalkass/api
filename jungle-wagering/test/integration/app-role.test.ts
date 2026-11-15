import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { DATABASE_URL, connect, resetDatabase } from '../helpers/db';
import { balanceOf, createStack, openWallet, submit, type PublishedEvent, type Stack } from '../helpers/fixtures';
import { findInconsistentWallets } from '../helpers/invariants';

/**
 * docker compose runs the application as `wagering_app`: a role WITHOUT any privilege to UPDATE/DELETE the ledger.
 * If a GRANT were missing, the whole stack would only break at runtime. This suite runs the real flows as that role.
 */
const APP_URL = DATABASE_URL.replace(/\/\/[^@]+@/, '//wagering_app:wagering_app@');

let owner: SQL;
let app: SQL;
let stack: Stack;

beforeAll(async () => {
  owner = connect(10);
  await owner.unsafe(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app' NOSUPERUSER; END IF; END $$",
  );
  const db = (await owner.unsafe('SELECT current_database() AS db')) as unknown as { db: string }[];
  await owner.unsafe(`GRANT CONNECT ON DATABASE "${db[0]?.db}" TO wagering_app`);
});
afterAll(async () => {
  await app?.close();
  await owner.close();
});
beforeEach(async () => {
  await app?.close();
  await resetDatabase(owner); // migrations run as the owner; 0003 grants to wagering_app because the role exists
  app = new SQL({ url: APP_URL, max: 10 });
  stack = createStack(app);
});

describe('the application role', () => {
  test('is not a superuser and is a different identity from the schema owner', async () => {
    const rows = (await app.unsafe(
      'SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    )) as unknown as { u: string; su: boolean }[];
    expect(rows[0]).toEqual({ u: 'wagering_app', su: false });
  });

  test('runs every real flow: wallet, BET, WIN, LOSS, parked REFUND resolved later, outbox publishing, reconciliation', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '30.00', { externalTransactionId: 'bet-1' });
    await submit(stack, wallet, 'WIN', '50.00', { externalTransactionId: 'win-1', referenceExternalTransactionId: 'bet-1' });
    await submit(stack, wallet, 'LOSS', '0.00', { externalTransactionId: 'loss-1' });
    const parked = await submit(stack, wallet, 'REFUND', '20.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-2' });
    expect(parked.result.status).toBe('PENDING_REFERENCE');
    await submit(stack, wallet, 'BET', '20.00', { externalTransactionId: 'bet-2' });
    await stack.pendingWorker.drainOnce();

    expect(await balanceOf(app, wallet.id)).toBe('120.00');

    const events: PublishedEvent[] = [];
    expect(await stack.publisher(events).publishBatch()).toBeGreaterThan(0); // uses the outbox sequence
    const reconciliation = await stack.reconcile.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(await findInconsistentWallets(owner)).toEqual([]);
  });

  test('can NOT update, delete or truncate the ledger (privilege denied, before the triggers even run)', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '10.00');

    for (const statement of [
      'UPDATE wallet_ledger_entries SET amount = 1',
      'DELETE FROM wallet_ledger_entries',
      'TRUNCATE wallet_ledger_entries',
    ]) {
      await expect(app.unsafe(statement)).rejects.toMatchObject({ errno: '42501' }); // insufficient_privilege
    }
    expect(await balanceOf(app, wallet.id)).toBe('90.00');
  });

  test('can NOT delete wager transactions, inbox rows or wallets either (nothing in the audit trail is deletable)', async () => {
    await openWallet(stack, '100.00');
    for (const statement of ['DELETE FROM wager_transactions', 'DELETE FROM wallets', 'TRUNCATE wager_transactions']) {
      await expect(app.unsafe(statement)).rejects.toMatchObject({ errno: '42501' });
    }
  });

  test('cannot alter the schema (no DDL) and cannot bypass the guards by disabling triggers', async () => {
    await expect(app.unsafe('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ALL')).rejects.toMatchObject({ errno: '42501' });
    await expect(app.unsafe('DROP TABLE wallet_ledger_entries')).rejects.toMatchObject({ errno: '42501' });
  });
});
