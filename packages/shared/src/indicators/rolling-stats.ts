/**
 * Rolling mean/std over a fixed-size trailing window, updated incrementally
 * (SPEC §4 — Welford-style). Used for the 1s tickVol and |return| baselines
 * live, and re-windowed to 30 candles in the backtester. Pure TS, no I/O.
 *
 * Add/evict use Welford's update and its inverse; for the window sizes here
 * (≤ a few hundred) this is numerically solid and O(1) per update.
 */
export class RollingStats {
  private readonly values: number[] = [];
  private head = 0; // ring-buffer index of the oldest value
  private n = 0;
  private mean = 0;
  private m2 = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new Error(`RollingStats capacity must be an integer ≥ 2, got ${capacity}`);
    }
  }

  push(value: number): void {
    if (this.n === this.capacity) {
      const old = this.values[this.head] as number;
      this.values[this.head] = value;
      this.head = (this.head + 1) % this.capacity;
      // combined remove-old + add-new update
      const oldMean = this.mean;
      this.mean += (value - old) / this.capacity;
      this.m2 += (value - old) * (value - this.mean + old - oldMean);
      if (this.m2 < 0) this.m2 = 0; // guard tiny negative drift
      return;
    }
    this.values[(this.head + this.n) % this.capacity] = value;
    this.n += 1;
    const delta = value - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (value - this.mean);
  }

  get count(): number {
    return this.n;
  }

  get average(): number {
    return this.n === 0 ? 0 : this.mean;
  }

  /** population standard deviation of the window */
  get std(): number {
    return this.n < 2 ? 0 : Math.sqrt(this.m2 / this.n);
  }

  /**
   * z-score of `value` against the window, with a std floor so early/quiet
   * windows don't produce explosive scores (SPEC §4 open-poisoning guard).
   */
  zScore(value: number, stdFloor = 0): number {
    const sd = Math.max(this.std, stdFloor);
    if (sd === 0) return 0;
    return (value - this.average) / sd;
  }

  reset(): void {
    this.values.length = 0;
    this.head = 0;
    this.n = 0;
    this.mean = 0;
    this.m2 = 0;
  }
}
