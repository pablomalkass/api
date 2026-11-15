import type { SQL } from 'bun';
import type { TxContext, UnitOfWork } from '../../src/application/ports';
import { classifyDbError } from '../../src/infrastructure/persistence/db-errors';
import { createTxContext } from '../../src/infrastructure/persistence/repositories';
import type { Row, SqlExecutor } from '../../src/infrastructure/persistence/sql-executor';

interface Queryable {
  unsafe(query: string, values?: unknown[]): Promise<unknown>;
}

export class BunSqlExecutor implements SqlExecutor {
  constructor(private readonly queryable: Queryable) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const rows = await this.queryable.unsafe(sql, [...params]);
    return Array.from(rows as ArrayLike<Row>);
  }
}

/**
 * Test adapter of the UnitOfWork port over a plain PostgreSQL connection pool (Bun.SQL).
 * It runs the very same repositories (SQL) as production: only the transaction plumbing differs
 * (production uses MikroORM's EntityManager.transactional()).
 */
export class BunUnitOfWork implements UnitOfWork {
  constructor(
    private readonly sql: SQL,
    private readonly options: { lockTimeoutMs?: number; statementTimeoutMs?: number } = {},
  ) {}

  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [
          `${this.options.lockTimeoutMs ?? 10_000}ms`,
          `${this.options.statementTimeoutMs ?? 30_000}ms`,
        ]);
        return work(createTxContext(new BunSqlExecutor(tx as unknown as Queryable)));
      });
    } catch (error) {
      throw classifyDbError(error);
    }
  }
}
