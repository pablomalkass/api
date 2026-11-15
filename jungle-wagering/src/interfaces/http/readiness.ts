export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, 'up' | 'down'>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

/** Readiness = every hard dependency answers within the timeout. Liveness never calls this (it only proves the process runs). */
export async function checkReadiness(
  probes: Record<string, () => Promise<void>>,
  timeoutMs = 2_000,
): Promise<ReadinessReport> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, probe]) => {
      try {
        await withTimeout(probe(), timeoutMs);
        return [name, 'up'] as const;
      } catch {
        return [name, 'down'] as const;
      }
    }),
  );
  const checks = Object.fromEntries(entries) as Record<string, 'up' | 'down'>;
  return { status: entries.every(([, state]) => state === 'up') ? 'ok' : 'unavailable', checks };
}
