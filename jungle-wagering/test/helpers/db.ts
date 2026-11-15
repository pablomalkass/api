import { SQL } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Integration tests run against a REAL PostgreSQL (docker compose provides one; so does any local server). */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@127.0.0.1:5432/wagering_test';

const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations/sql');

export function connect(max = 20): SQL {
  return new SQL({ url: DATABASE_URL, max });
}

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.up.sql'))
    .map((file) => file.replace('.up.sql', ''))
    .sort();
}

/** Applies the versioned SQL migrations (the same files `bun run migration:up` applies), up or down. */
export async function migrate(sql: SQL, direction: 'up' | 'down'): Promise<void> {
  const names = migrationNames();
  const ordered = direction === 'up' ? names : [...names].reverse();
  for (const name of ordered) {
    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, `${name}.${direction}.sql`), 'utf8'));
  }
}

export async function resetDatabase(sql: SQL): Promise<void> {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, 'up');
}
