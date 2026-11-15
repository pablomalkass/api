import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Migrator } from '../../src/infrastructure/persistence/migrator';
import { connect } from '../helpers/db';

let sql: SQL;
const REAL_DIR = join(import.meta.dir, '../../migrations/sql');

beforeAll(() => {
  sql = connect(20);
});
afterAll(async () => {
  await sql.close();
});
beforeEach(async () => {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

const tables = async () =>
  ((await sql.unsafe("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")) as unknown as { tablename: string }[]).map(
    (r) => r.tablename,
  );

describe('versioned, reversible migrations (the real ones)', () => {
  test('up applies everything in order, is idempotent, and records what ran', async () => {
    const migrator = new Migrator(sql, REAL_DIR);
    const first = await migrator.up();
    expect(first).toEqual(['0001_core_tables', '0002_messaging_tables', '0003_integrity_guards_and_grants']);
    expect(await migrator.up()).toEqual([]);
    expect(await tables()).toEqual(['inbox_messages', 'outbox_messages', 'schema_migrations', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
    expect((await migrator.status()).every((s) => s.applied)).toBe(true);
  });

  test('down reverts newest-first, one step at a time, and up restores it (repeatable cycle)', async () => {
    const migrator = new Migrator(sql, REAL_DIR);
    await migrator.up();

    expect(await migrator.down(1)).toEqual(['0003_integrity_guards_and_grants']);
    // The guards are gone: the ledger is mutable again at this version.
    const triggers = (await sql.unsafe('SELECT count(*) AS c FROM pg_trigger WHERE NOT tgisinternal')) as unknown as { c: string }[];
    expect(Number(triggers[0]?.c)).toBe(0);

    expect(await migrator.down(Number.MAX_SAFE_INTEGER)).toEqual(['0002_messaging_tables', '0001_core_tables']);
    expect(await tables()).toEqual(['schema_migrations']);
    expect(await migrator.down(1)).toEqual([]); // nothing left

    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await migrator.up()).toHaveLength(3);
      expect(await migrator.down(3)).toHaveLength(3);
    }
    await migrator.up();
    expect((await tables()).length).toBe(6);
  });

  test('six instances starting at once apply every migration exactly once (advisory lock)', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => new Migrator(sql, REAL_DIR).up()));
    const flat = results.flat();
    expect(flat.sort()).toEqual(['0001_core_tables', '0002_messaging_tables', '0003_integrity_guards_and_grants']);
    const rows = (await sql.unsafe('SELECT count(*) AS c FROM schema_migrations')) as unknown as { c: string }[];
    expect(Number(rows[0]?.c)).toBe(3);
  });

  test('every migration ships a down script', () => {
    const files = new Migrator(sql, REAL_DIR).load();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) expect(file.down.trim().length).toBeGreaterThan(0);
  });
});

describe('migration safety', () => {
  const scratch = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  test('a migration without a down script is refused (reversibility is mandatory)', () => {
    const dir = scratch({ '0001_a.up.sql': 'SELECT 1' });
    expect(() => new Migrator(sql, dir).load()).toThrow('not reversible');
  });

  test('a failing migration rolls back completely and is not recorded', async () => {
    const dir = scratch({
      '0001_ok.up.sql': 'CREATE TABLE ok_table (id int)',
      '0001_ok.down.sql': 'DROP TABLE ok_table',
      '0002_broken.up.sql': 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;',
      '0002_broken.down.sql': 'DROP TABLE half_done',
    });
    const migrator = new Migrator(sql, dir);
    await expect(migrator.up()).rejects.toThrow();

    expect(await tables()).toEqual(['ok_table', 'schema_migrations']); // half_done did not survive
    expect((await migrator.status()).map((s) => s.applied)).toEqual([true, false]);
  });

  test('migration names must be NNNN_snake_case', () => {
    const dir = scratch({ 'bad-name.up.sql': 'SELECT 1', 'bad-name.down.sql': 'SELECT 1' });
    expect(() => new Migrator(sql, dir).load()).toThrow('invalid migration name');
  });
});
