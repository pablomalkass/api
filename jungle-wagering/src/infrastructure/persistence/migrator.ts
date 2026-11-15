import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the migrator needs from Bun.SQL: run a transaction on one connection. */
export interface MigrationDatabase {
  begin<T>(work: (tx: { unsafe(query: string, values?: unknown[]): Promise<unknown> }) => Promise<T>): Promise<T>;
}

export interface MigrationFile {
  name: string;
  up: string;
  down: string;
}

/**
 * Versioned, REVERSIBLE migrations: `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs in a directory.
 * Plain SQL on purpose: CHECK constraints, partial indexes, triggers and grants are part of the design under
 * evaluation and no schema generator expresses them faithfully.
 *
 * Safe when several instances start at once: every run takes a transaction-scoped advisory lock, so migrations are
 * applied exactly once; the others wait, then find nothing left to do. Each migration is applied in its own
 * transaction together with its bookkeeping row (PostgreSQL DDL is transactional).
 */
export class Migrator {
  constructor(
    private readonly db: MigrationDatabase,
    private readonly directory: string,
  ) {}

  load(): MigrationFile[] {
    const ups = readdirSync(this.directory)
      .filter((file) => file.endsWith('.up.sql'))
      .sort();
    return ups.map((file) => {
      const name = file.replace(/\.up\.sql$/, '');
      if (!/^\d{4}_[a-z0-9_]+$/.test(name)) throw new Error(`invalid migration name "${name}" (expected NNNN_snake_case)`);
      let down: string;
      try {
        down = readFileSync(join(this.directory, `${name}.down.sql`), 'utf8');
      } catch {
        throw new Error(`migration ${name} is not reversible: ${name}.down.sql is missing`);
      }
      return { name, up: readFileSync(join(this.directory, file), 'utf8'), down };
    });
  }

  async status(): Promise<{ name: string; applied: boolean }[]> {
    const applied = await this.db.begin(async (tx) => {
      await this.ensureTable(tx);
      return this.appliedNames(tx);
    });
    return this.load().map((m) => ({ name: m.name, applied: applied.has(m.name) }));
  }

  /** Applies every pending migration in order. Returns the names applied by THIS call. */
  async up(): Promise<string[]> {
    const files = this.load();
    const done: string[] = [];
    for (const file of files) {
      const applied = await this.db.begin(async (tx) => {
        await this.lock(tx);
        await this.ensureTable(tx);
        if ((await this.appliedNames(tx)).has(file.name)) return false;
        await tx.unsafe(file.up);
        await tx.unsafe('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
        return true;
      });
      if (applied) done.push(file.name);
    }
    return done;
  }

  /** Reverts the last `steps` applied migrations (newest first). Returns the names reverted. */
  async down(steps = 1): Promise<string[]> {
    const files = new Map(this.load().map((m) => [m.name, m]));
    const reverted: string[] = [];
    for (let i = 0; i < steps; i++) {
      const name = await this.db.begin(async (tx) => {
        await this.lock(tx);
        await this.ensureTable(tx);
        const rows = (await tx.unsafe('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')) as { name: string }[];
        const last = rows[0]?.name;
        if (!last) return undefined;
        const file = files.get(last);
        if (!file) throw new Error(`applied migration ${last} has no files on disk`);
        await tx.unsafe(file.down);
        await tx.unsafe('DELETE FROM schema_migrations WHERE name = $1', [last]);
        return last;
      });
      if (!name) break;
      reverted.push(name);
    }
    return reverted;
  }

  private async lock(tx: { unsafe(query: string, values?: unknown[]): Promise<unknown> }): Promise<void> {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('wagering_schema_migrations'))");
  }

  private async ensureTable(tx: { unsafe(query: string, values?: unknown[]): Promise<unknown> }): Promise<void> {
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        text        PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  private async appliedNames(tx: { unsafe(query: string, values?: unknown[]): Promise<unknown> }): Promise<Set<string>> {
    const rows = (await tx.unsafe('SELECT name FROM schema_migrations')) as { name: string }[];
    return new Set(Array.from(rows, (row) => row.name));
  }
}
