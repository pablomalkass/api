/** Retry budget for transactions waiting on a referenced transaction that has not arrived yet. */
export interface ReferenceRetryPolicy {
  /**
   * Resolution attempts counted (the first one happens when the transaction is accepted). Once this many were
   * spent, the NEXT evaluation is the verdict: it still looks the reference up (so a reference that arrives at the
   * last moment is applied) and rejects only if it is still missing.
   */
  maxAttempts: number;
  /** Absolute time-to-live from the first attempt. Whichever limit hits first wins. */
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Defaults: delays 2s,4s,8s,16s,32s,64s,120s,120s,120s (~8 minutes over 10 attempts), hard TTL 15 min.
 * Provider redeliveries of a BET normally land within seconds; this budget absorbs queue lag without
 * keeping dead references alive forever.
 */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  maxAttempts: 10,
  ttlMs: 15 * 60 * 1000,
  baseDelayMs: 2_000,
  maxDelayMs: 120_000,
};

/**
 * Exponential backoff with +-20% jitter. `attempt` is 1-based (the attempt that just failed).
 * `jitter01` is injected (a number in [0,1)) so the function stays deterministic and testable.
 */
export function computeBackoffMs(attempt: number, base: number, max: number, jitter01 = 0.5): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + 0.4 * jitter01));
}
