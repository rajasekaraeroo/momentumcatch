/**
 * Reconnect backoff (SPEC §9): exponential 1s → 30s cap.
 * Jitter (±20%) avoids reconnect stampedes; injectable RNG keeps tests exact.
 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

export function backoffMs(attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_CAP_MS);
  const jitter = 1 + (rng() * 2 - 1) * 0.2;
  return Math.round(exp * jitter);
}
