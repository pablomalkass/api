import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver, type EntityManager } from '@mikro-orm/postgresql';
import type { TxContext, UnitOfWork } from '../../application/ports';
import { classifyDbError } from './db-errors';
import { createTxContext } from './repositories';
import { toKnexStyleQuery } from './sql-params';
import type { Row, SqlExecutor } from './sql-executor';

export interface MikroOrmOptions {
  clientUrl: string;
  poolMin: number;
  poolMax: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/** Initialises MikroORM as the connection pool + transaction manager. There are no mapped entities (see ARCHITECTURE.md). */
export function initMikroOrm(options: MikroOrmOptions): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>({
    driver: PostgreSqlDriver,
    clientUrl: options.clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false, requireEntitiesArray: false },
    pool: { min: options.poolMin, max: options.poolMax },
    // The schema is owned by the versioned SQL migrations, never by schema generation.
    ensureDatabase: false,
    allowGlobalContext: false,
    // Never log statements: parameters carry monetary values.
    debug: false,
  });
}

/** Runs repository SQL through the EntityManager that owns the CURRENT transaction. */
class MikroOrmSqlExecutor implements SqlExecutor {
  constructor(private readonly em: EntityManager) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const { sql: knexSql, bindings } = toKnexStyleQuery(sql, params);
    const rows = await this.em.execute<Row[]>(knexSql, bindings, 'all');
    return Array.isArray(rows) ? rows : [];
  }
}

/**
 * UnitOfWork over MikroORM's `EntityManager.transactional()`: one fork per unit of work (own identity map, own
 * transaction), BEGIN ... COMMIT/ROLLBACK around the callback, and lock/statement timeouts scoped to the transaction
 * (`set_config(..., true)` == SET LOCAL), so a stuck wallet lock becomes a bounded, retryable error.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly options: { lockTimeoutMs: number; statementTimeoutMs: number },
  ) {}

  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (tem) => {
        await tem.execute(
          "SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
          [`${this.options.lockTimeoutMs}ms`, `${this.options.statementTimeoutMs}ms`],
          'all',
        );
        return work(createTxContext(new MikroOrmSqlExecutor(tem as EntityManager)));
      });
    } catch (error) {
      throw classifyDbError(error);
    }
  }

  /** Readiness probe: a trivial round trip through the pool. */
  async ping(): Promise<void> {
    await this.orm.em.fork().execute('SELECT 1', [], 'all');
  }

  close(): Promise<void> {
    return this.orm.close(true);
  }
}
