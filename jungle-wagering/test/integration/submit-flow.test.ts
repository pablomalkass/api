import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError, TransactionNotFoundError } from '../../src/application/errors';
import { parseCreateWalletCommand } from '../../src/application/parsers';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import type { LedgerRepository, TxContext, UnitOfWork } from '../../src/application/ports';
import { connect, resetDatabase } from '../helpers/db';
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
  uniqueId,
  type Stack,
} from '../helpers/fixtures';
import { findInconsistentWallets } from '../helpers/invariants';

let sql: SQL;
let stack: Stack;

beforeAll(() => {
  sql = connect(10);
  stack = createStack(sql);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await resetDatabase(sql);
});

const ctx = () => ({ correlationId: uniqueId('corr') });

describe('wallet creation', () => {
  test('a positive initial balance creates the OPENING transaction and its CREDIT entry atomically', async () => {
    const wallet = await openWallet(stack, '1000.00');
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    const [opening] = (await sql.unsafe(
      "SELECT kind, status, provider_id, observed_balance FROM wager_transactions WHERE wallet_id = $1",
      [wallet.id],
    )) as { kind: string; status: string; provider_id: string; observed_balance: string }[];
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal', observed_balance: '1000.00' });
    const [entry] = (await sql.unsafe('SELECT direction, balance_before, balance_after, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])) as Record<string, string>[];
    expect(entry).toMatchObject({ direction: 'CREDIT', balance_before: '0.00', balance_after: '1000.00' });
    expect(Number(entry?.wallet_version)).toBe(1);
    expect(await outboxTypes(sql, wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('a zero initial balance creates no OPENING transaction and no ledger entry', async () => {
    const wallet = await openWallet(stack, '0.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(0);
    const rows = (await sql.unsafe('SELECT count(*) AS c FROM wager_transactions WHERE wallet_id = $1', [wallet.id])) as { c: string }[];
    expect(Number(rows[0]?.c)).toBe(0);
    expect(await outboxTypes(sql, wallet.id)).toEqual([]);
  });

  test('a duplicate (playerId, currency) is a conflict; another currency is fine', async () => {
    const playerId = randomUUID();
    const create = (currency: string) =>
      stack.createWallet.execute(parseCreateWalletCommand({ playerId, initialBalance: { amount: '10.00', currency } }), ctx());
    await create('BRL');
    await expect(create('BRL')).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await create('USD');
  });

  test('concurrent creation of the same wallet yields exactly one wallet', async () => {
    const playerId = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        stack.createWallet.execute(parseCreateWalletCommand({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }), ctx()),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof WalletAlreadyExistsError).length).toBe(9);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});

describe('BET / WIN / LOSS / REFUND / ROLLBACK', () => {
  test('BET debits, writes one DEBIT entry and emits Processed + BalanceChanged', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const { result } = await submit(stack, wallet, 'BET', '25.00');
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await balanceOf(sql, wallet.id)).toBe('975.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
    expect((await stack.queries.getWallet(wallet.id)).version).toBe(2);
    expect((await outboxTypes(sql, wallet.id)).slice(2)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('WIN credits', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result } = await submit(stack, wallet, 'WIN', '55.50');
    expect(result.balance?.amount).toBe('155.50');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
  });

  test('LOSS moves nothing: no ledger entry, no version bump, no BalanceChanged event, but a Processed event', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result } = await submit(stack, wallet, 'LOSS', '40.00');
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect((await stack.queries.getWallet(wallet.id)).version).toBe(1);
    expect((await outboxTypes(sql, wallet.id)).slice(2)).toEqual(['WagerTransactionProcessed']);
  });

  test('WIN and LOSS may reference the BET of their round', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '10.00');
    const win = await submit(stack, wallet, 'WIN', '30.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(win.result.status).toBe('PROCESSED');
    const view = await stack.queries.getTransactionById(win.result.transactionId);
    expect(view.referenceTransactionId).toBe(bet.result.transactionId);
  });

  test('REFUND reverts a processed BET, once', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    const refund = await submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(refund.result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const view = await stack.queries.getTransactionById(refund.result.transactionId);
    expect(view.referenceTransactionId).toBe(bet.result.transactionId);

    const again = await submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(again.result).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED', balance: { amount: '100.00' } });
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('ROLLBACK of a BET credits; of a WIN debits; of a REFUND debits', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '20.00'); // 80
    const rollbackBet = await submit(stack, wallet, 'ROLLBACK', '20.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(rollbackBet.result.balance?.amount).toBe('100.00');

    const win = await submit(stack, wallet, 'WIN', '50.00'); // 150
    const rollbackWin = await submit(stack, wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.command.externalTransactionId });
    expect(rollbackWin.result.balance?.amount).toBe('100.00');

    const bet2 = await submit(stack, wallet, 'BET', '10.00'); // 90
    const refund = await submit(stack, wallet, 'REFUND', '10.00', { referenceExternalTransactionId: bet2.command.externalTransactionId }); // 100
    const rollbackRefund = await submit(stack, wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: refund.command.externalTransactionId }); // 90
    expect(rollbackRefund.result).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test('a reversal can happen only once across REFUND and ROLLBACK (no double credit of the same BET)', async () => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    await submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    const rollback = await submit(stack, wallet, 'ROLLBACK', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(rollback.result).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('ROLLBACK that would overdraw is rejected with its own code, audited, and leaves the balance alone', async () => {
    const wallet = await openWallet(stack, '100.00');
    const win = await submit(stack, wallet, 'WIN', '150.00'); // 250
    await submit(stack, wallet, 'BET', '240.00'); // 10, the player spent the winnings
    const rollback = await submit(stack, wallet, 'ROLLBACK', '150.00', { referenceExternalTransactionId: win.command.externalTransactionId });
    expect(rollback.result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: { amount: '10.00' } });
    expect(rollback.result.failureCode).not.toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(sql, wallet.id)).toBe('10.00');
    const stored = await stack.queries.getTransactionById(rollback.result.transactionId);
    expect(stored.status).toBe('REJECTED');
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });

  test.each([
    ['amount differs', { money: { amount: '24.00', currency: 'BRL' } }, 'REFERENCE_AMOUNT_MISMATCH'],
    ['round differs', { roundId: 'another-round' }, 'REFERENCE_MISMATCH_ROUND'],
  ])('a reversal whose %s is rejected', async (_name, over, code) => {
    const wallet = await openWallet(stack, '100.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    const refund = await submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId, ...over });
    expect(refund.result).toMatchObject({ status: 'REJECTED', failureCode: code });
    expect(await balanceOf(sql, wallet.id)).toBe('75.00');
  });

  test('a reversal of a REJECTED BET is rejected (nothing to reverse)', async () => {
    const wallet = await openWallet(stack, '10.00');
    const bet = await submit(stack, wallet, 'BET', '25.00');
    expect(bet.result.status).toBe('REJECTED');
    const refund = await submit(stack, wallet, 'REFUND', '25.00', { referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(refund.result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_REJECTED' });
    expect(await balanceOf(sql, wallet.id)).toBe('10.00');
  });
});

describe('rejections are committed, auditable facts', () => {
  test('insufficient funds: REJECTED, observed balance, no ledger entry, no balance event', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result } = await submit(stack, wallet, 'BET', '150.00');
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '100.00' } });
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect((await stack.queries.getWallet(wallet.id)).version).toBe(1);
    expect((await outboxTypes(sql, wallet.id)).slice(2)).toEqual(['WagerTransactionRejected']);
    const stored = await stack.queries.getTransactionById(result.transactionId);
    expect(stored).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('a player that does not own the wallet is rejected', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result } = await submit(stack, { id: wallet.id, playerId: 'an-impostor' }, 'BET', '1.00');
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(await balanceOf(sql, wallet.id)).toBe('100.00');
  });

  test('a currency different from the wallet currency is rejected', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result } = await submit(stack, wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } });
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
  });

  test('an unknown wallet cannot be recorded and surfaces as WalletNotFoundError', async () => {
    const ghost = { id: randomUUID(), playerId: 'p' };
    await expect(submit(stack, ghost, 'BET', '1.00')).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('a mistake in the database never leaves a half-recorded transaction behind', async () => {
    const wallet = await openWallet(stack, '100.00');
    await expect(submit(stack, ghostOf(wallet), 'BET', '1.00')).rejects.toBeInstanceOf(WalletNotFoundError);
    const rows = (await sql.unsafe("SELECT count(*) AS c FROM wager_transactions WHERE provider_id = 'provider-a'")) as { c: string }[];
    expect(Number(rows[0]?.c)).toBe(0);
  });
});

function ghostOf(wallet: { playerId: string }) {
  return { id: randomUUID(), playerId: wallet.playerId };
}

describe('idempotency', () => {
  test('the same request returns the ORIGINAL result, including the balance observed at that moment', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const first = await submit(stack, wallet, 'BET', '25.00');
    await submit(stack, wallet, 'BET', '100.00'); // the balance moves on: 875.00
    const replay = await stack.useCase.submit(first.command, ctx());
    expect(replay).toEqual({ ...first.result, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('975.00');
    expect(await balanceOf(sql, wallet.id)).toBe('875.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(3);
  });

  test('a replayed REJECTION returns the same rejection and still does not touch the wallet', async () => {
    const wallet = await openWallet(stack, '10.00');
    const first = await submit(stack, wallet, 'BET', '25.00');
    const replay = await stack.useCase.submit(first.command, ctx());
    expect(replay).toEqual({ ...first.result, idempotentReplay: true });
    expect(replay.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('the same key with a different payload is a CONFLICT, not a replay, and changes nothing', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const first = await submit(stack, wallet, 'BET', '25.00');
    const tampered = command(wallet, 'BET', '26.00', { externalTransactionId: first.command.externalTransactionId });
    const forged = { ...tampered, idempotencyKey: first.command.idempotencyKey };
    await expect(stack.useCase.submit(forged, ctx())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(sql, wallet.id)).toBe('975.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
  });

  test('the same provider + externalTransactionId under another key is also a conflict', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const first = await submit(stack, wallet, 'BET', '25.00');
    const other = { ...first.command, idempotencyKey: 'a-different-key' };
    await expect(stack.useCase.submit(other, ctx())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(sql, wallet.id)).toBe('975.00');
  });

  test('idempotency lives in the database: a brand-new use case instance still dedupes', async () => {
    const wallet = await openWallet(stack, '1000.00');
    const first = await submit(stack, wallet, 'BET', '25.00');
    const fresh = createStack(sql); // no shared memory whatsoever
    const replay = await fresh.useCase.submit(first.command, ctx());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.result.transactionId);
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
  });

  test('metrics count real transactions and duplicates separately', async () => {
    const local = createStack(sql); // its own metrics registry: the shared one accumulates across tests
    const wallet = await openWallet(local, '1000.00');
    const first = await submit(local, wallet, 'BET', '25.00');
    await local.useCase.submit(first.command, ctx());
    await local.useCase.submit(first.command, ctx());
    expect(local.metrics.counter('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    expect(local.metrics.counter('wager_duplicates_total', { source: 'http', type: 'idempotency' })).toBe(2);
  });
});

describe('atomicity: wallet, ledger, transaction, inbox and outbox commit together or not at all', () => {
  /** A unit of work that fails at a chosen point of the very same statements production runs. */
  function failingUow(failAt: 'after-ledger' | 'after-outbox'): UnitOfWork {
    return {
      run: <T>(work: (tx: TxContext) => Promise<T>) =>
        stack.uow.run((tx) => {
          const ledger: LedgerRepository = {
            append: async (entry) => {
              await tx.ledger.append(entry);
              if (failAt === 'after-ledger') throw new Error('simulated crash after the ledger insert');
            },
            listByWallet: (...args) => tx.ledger.listByWallet(...args),
            reconcile: (...args) => tx.ledger.reconcile(...args),
          };
          const outbox = {
            enqueue: async (message: Parameters<TxContext['outbox']['enqueue']>[0]) => {
              await tx.outbox.enqueue(message);
              if (failAt === 'after-outbox') throw new Error('simulated crash after the outbox insert');
            },
            claimDue: (...args: Parameters<TxContext['outbox']['claimDue']>) => tx.outbox.claimDue(...args),
            save: (message: Parameters<TxContext['outbox']['save']>[0]) => tx.outbox.save(message),
            lagSeconds: (now: Date) => tx.outbox.lagSeconds(now),
          };
          return work({ ...tx, ledger, outbox });
        }),
    };
  }

  test.each(['after-ledger', 'after-outbox'] as const)('a crash %s rolls EVERYTHING back, and the retry applies exactly once', async (failAt) => {
    const wallet = await openWallet(stack, '1000.00');
    const outboxBefore = (await outboxTypes(sql, wallet.id)).length;
    const crashing = new ProcessWagerTransactionUseCase({ uow: failingUow(failAt), clock: new SystemClock(), ids: new UuidGenerator() });
    const cmd = command(wallet, 'BET', '25.00');

    await expect(crashing.submit(cmd, ctx())).rejects.toThrow(/simulated crash/);

    expect(await balanceOf(sql, wallet.id)).toBe('1000.00');
    expect(await ledgerCount(sql, wallet.id)).toBe(1);
    expect((await stack.queries.getWallet(wallet.id)).version).toBe(1);
    expect((await outboxTypes(sql, wallet.id)).length).toBe(outboxBefore);
    await expect(stack.queries.getTransactionByProvider(cmd.providerId, cmd.externalTransactionId)).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );

    const retried = await stack.useCase.submit(cmd, ctx());
    expect(retried).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '975.00' } });
    expect(await ledgerCount(sql, wallet.id)).toBe(2);
    expect(await findInconsistentWallets(sql)).toEqual([]);
  });
});

describe('queries', () => {
  test('GET transaction by internal id and by (provider, externalId); unknown ids are NotFound', async () => {
    const wallet = await openWallet(stack, '100.00');
    const { result, command: cmd } = await submit(stack, wallet, 'BET', '10.00');
    const byId = await stack.queries.getTransactionById(result.transactionId);
    const byExternal = await stack.queries.getTransactionByProvider(cmd.providerId, cmd.externalTransactionId);
    expect(byId).toEqual(byExternal);
    expect(byId).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '10.00', currency: 'BRL' }, balance: { amount: '90.00' } });
    await expect(stack.queries.getTransactionById(randomUUID())).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(stack.queries.getTransactionByProvider('provider-a', 'nope')).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(stack.queries.getWallet(randomUUID())).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('ledger pagination: stable opaque cursor, newest first, no gaps, no overlap', async () => {
    const wallet = await openWallet(stack, '1000.00');
    for (let i = 0; i < 6; i++) await submit(stack, wallet, 'BET', '1.00'); // 7 entries in total with the opening one

    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await stack.queries.getLedger(wallet.id, cursor, 3);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.walletVersion));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  test('ledger cursors stay valid while new entries arrive', async () => {
    const wallet = await openWallet(stack, '1000.00');
    for (let i = 0; i < 4; i++) await submit(stack, wallet, 'BET', '1.00');
    const first = await stack.queries.getLedger(wallet.id, undefined, 2);
    await submit(stack, wallet, 'BET', '1.00'); // a new entry appears between pages
    const second = await stack.queries.getLedger(wallet.id, first.nextCursor, 2);
    expect(first.items.map((i) => i.walletVersion)).toEqual([5, 4]);
    expect(second.items.map((i) => i.walletVersion)).toEqual([3, 2]);
  });

  test('ledger limit and cursor are validated, and an unknown wallet is NotFound', async () => {
    const wallet = await openWallet(stack, '10.00');
    await expect(stack.queries.getLedger(wallet.id, undefined, 0)).rejects.toMatchObject({ details: [{ field: 'limit' }] });
    await expect(stack.queries.getLedger(wallet.id, undefined, 500)).rejects.toMatchObject({ details: [{ field: 'limit' }] });
    await expect(stack.queries.getLedger(wallet.id, 'garbage', 10)).rejects.toMatchObject({ details: [{ field: 'cursor' }] });
    await expect(stack.queries.getLedger(randomUUID(), undefined, 10)).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('ledger entries expose the full audit trail', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '30.00');
    const page = await stack.queries.getLedger(wallet.id, undefined, 10);
    expect(page.items[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00' },
      balanceAfter: { amount: '70.00' },
      walletVersion: 2,
    });
  });
});

describe('reconciliation', () => {
  test('a healthy wallet reconciles with zero difference', async () => {
    const wallet = await openWallet(stack, '500.00');
    await submit(stack, wallet, 'BET', '125.50');
    const win = await submit(stack, wallet, 'WIN', '40.00');
    await submit(stack, wallet, 'ROLLBACK', '40.00', { referenceExternalTransactionId: win.command.externalTransactionId });
    const report = await stack.reconcile.execute(wallet.id);
    expect(report).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '374.50', currency: 'BRL' },
      calculatedBalance: { amount: '374.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      chainIntact: true,
      checkedEntries: 4,
    });
    expect(stack.metrics.counter('reconciliation_divergences_total')).toBe(0);
  });

  test('a wallet with no entries reconciles at zero', async () => {
    const wallet = await openWallet(stack, '0.00');
    const report = await stack.reconcile.execute(wallet.id);
    expect(report).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: { amount: '0.00' } });
  });

  test('a divergence is REPORTED, counted and logged, never silently corrected', async () => {
    const wallet = await openWallet(stack, '100.00');
    await submit(stack, wallet, 'BET', '10.00');
    // Simulate corruption the schema guards would normally prevent (DBA bypass of the deferred trigger).
    await sql.unsafe('ALTER TABLE wallets DISABLE TRIGGER trg_wallet_ledger_consistent');
    await sql.unsafe('UPDATE wallets SET balance = balance + 5.00 WHERE id = $1', [wallet.id]);
    await sql.unsafe('ALTER TABLE wallets ENABLE TRIGGER trg_wallet_ledger_consistent');

    const logged: Record<string, unknown>[] = [];
    const { ReconcileWalletUseCase } = await import('../../src/application/reconcile-wallet');
    const reconcile = new ReconcileWalletUseCase(stack.uow, {
      metrics: stack.metrics,
      logger: { debug() {}, info() {}, warn() {}, error: (_m, f) => void logged.push(f ?? {}) },
    });
    const report = await reconcile.execute(wallet.id);

    expect(report).toMatchObject({
      storedBalance: { amount: '95.00' },
      calculatedBalance: { amount: '90.00' },
      difference: { amount: '5.00' },
      consistent: false,
    });
    expect(stack.metrics.counter('reconciliation_divergences_total')).toBe(1);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ walletId: wallet.id, difference: '5.00' });
    expect(await balanceOf(sql, wallet.id)).toBe('95.00'); // untouched
    expect((await findInconsistentWallets(sql, [wallet.id])).length).toBe(1);
  });

  test('an unknown wallet is NotFound', async () => {
    await expect(stack.reconcile.execute(randomUUID())).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
