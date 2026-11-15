export type Row = Record<string, unknown>;

/**
 * The only thing the repositories need from a database driver: run a parameterised statement ($1, $2, ...)
 * inside the CURRENT transaction and give back the rows. MikroORM's EntityManager implements it in production;
 * the integration tests implement it over a plain PostgreSQL connection.
 */
export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}
