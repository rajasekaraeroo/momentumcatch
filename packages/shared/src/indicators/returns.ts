/**
 * Log return between two prices (SPEC §5.1). Returns 0 when either price is
 * non-positive — a defensive guard for bad prints; callers treat 0 as "no
 * information", never as a signal.
 */
export function logReturn(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return Math.log(to / from);
}
