import { ApplicationError, PermanentInfrastructureError, TransientInfrastructureError, type TransientReason } from '../../application/errors';

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Extracts the 5-character SQLSTATE from the different error shapes drivers produce. */
export function sqlState(error: unknown): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    for (const field of ['code', 'errno', 'sqlState']) {
      const value = record[field];
      if (typeof value === 'string' && SQLSTATE.test(value)) return value;
    }
  }
  return undefined;
}

export function constraintName(error: unknown): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    for (const field of ['constraint', 'constraint_name']) {
      const value = record[field];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

/** True for a violation of a specific named constraint (e.g. 23505 uq_wallets_player_currency). */
export function isConstraintViolation(error: unknown, state: string, constraint: string): boolean {
  return sqlState(error) === state && constraintName(error) === constraint;
}

const TRANSIENT_STATES: Readonly<Record<string, TransientReason>> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
  '57014': 'lock_timeout', // statement_timeout / query_canceled
  '53000': 'resources',
  '53100': 'resources',
  '53200': 'resources',
  '53300': 'resources',
  '53400': 'resources',
  '57P01': 'connection',
  '57P02': 'connection',
  '57P03': 'connection',
};

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|connection (terminated|closed|ended)|Connection closed|timeout expired|terminating connection/i;

/**
 * Maps driver errors to the application's taxonomy:
 *  - ApplicationErrors pass through untouched;
 *  - lock timeouts, deadlocks, serialization failures, resource exhaustion and network trouble -> Transient (retry);
 *  - data (22xxx), integrity (23xxx) and schema/syntax (42xxx) errors -> Permanent (retrying cannot help);
 *  - anything else is returned as-is (callers treat unknown errors as transient by default).
 */
export function classifyDbError(error: unknown): unknown {
  if (error instanceof ApplicationError) return error;

  const state = sqlState(error);
  if (state) {
    const transient = TRANSIENT_STATES[state];
    if (transient) return new TransientInfrastructureError(transient, error);
    if (state.startsWith('08')) return new TransientInfrastructureError('connection', error);
    if (state.startsWith('22') || state.startsWith('23') || state.startsWith('42')) {
      return new PermanentInfrastructureError(
        `database rejected the statement (${state}${constraintName(error) ? `, ${constraintName(error)}` : ''})`,
        error,
      );
    }
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_PATTERN.test(message)) return new TransientInfrastructureError('connection', error);
  return error;
}
