import type { Tick } from "@momentum-scan/shared";

/**
 * Tick hygiene (SPEC §3): drop exact duplicates (same ts+ltp+volume for an
 * instrument), tolerate small out-of-order timestamp skew, flag large skew
 * so the caller can log it.
 */

export type FilterVerdict =
  | { action: "accept"; largeSkewMs?: number }
  | { action: "drop-duplicate" };

export class TickFilter {
  private readonly last = new Map<
    string,
    { ts: number; ltp: number; volume?: number }
  >();

  constructor(private readonly largeSkewThresholdMs = 2_000) {}

  check(tick: Tick): FilterVerdict {
    const prev = this.last.get(tick.instrumentKey);
    if (
      prev &&
      prev.ts === tick.ts &&
      prev.ltp === tick.ltp &&
      prev.volume === tick.volume
    ) {
      return { action: "drop-duplicate" };
    }
    let largeSkewMs: number | undefined;
    if (prev && tick.ts < prev.ts) {
      const skew = prev.ts - tick.ts;
      if (skew > this.largeSkewThresholdMs) largeSkewMs = skew;
      // Small skew: tolerate silently, keep the tick (SPEC §3).
    }
    // Track the max-ts snapshot so one stale tick can't reset dedupe state.
    if (!prev || tick.ts >= prev.ts) {
      this.last.set(tick.instrumentKey, {
        ts: tick.ts,
        ltp: tick.ltp,
        volume: tick.volume,
      });
    }
    return { action: "accept", largeSkewMs };
  }

  reset(): void {
    this.last.clear();
  }
}
