/**
 * Usage:
 *   bun src/cli/migrate.ts up
 *   bun src/cli/migrate.ts down [steps|all]
 *   bun src/cli/migrate.ts status
 */
import { SQL } from 'bun';
import { join } from 'node:path';
import { Migrator } from '../infrastructure/persistence/migrator';

// Migrations run as the schema OWNER (MIGRATION_DATABASE_URL); the application connects as a role that can never
// UPDATE/DELETE the ledger. Falls back to DATABASE_URL for local use.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}

const sql = new SQL({ url, max: 2 });
const migrator = new Migrator(sql, process.env.MIGRATIONS_DIR ?? join(import.meta.dir, '../../migrations/sql'));

try {
  const command = process.argv[2] ?? 'up';
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  } else if (command === 'down') {
    const arg = process.argv[3] ?? '1';
    const steps = arg === 'all' ? Number.MAX_SAFE_INTEGER : Number(arg);
    if (!Number.isInteger(steps) || steps < 1) throw new Error('steps must be a positive integer or "all"');
    const reverted = await migrator.down(steps);
    console.log(reverted.length ? `reverted: ${reverted.join(', ')}` : 'nothing to revert');
  } else if (command === 'status') {
    for (const item of await migrator.status()) console.log(`${item.applied ? '[x]' : '[ ]'} ${item.name}`);
  } else {
    throw new Error(`unknown command "${command}"`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.close();
}
