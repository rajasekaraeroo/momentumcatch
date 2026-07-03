import type { Bar } from "@momentum-scan/shared";
import { logReturn, RollingStats } from "@momentum-scan/shared";
import { toIst, parseHhMm } from "../feed/market-hours";

/**
 * Per-instrument baselines for z-scores (SPEC §4): rolling mean/std of 1s
 * tickVol and 1s |log return| over the trailing window, Welford-updated.
 * Bars inside the open-exclusion window (first `openExclusionSec` after the
 * session open) are excluded so opening prints don't poison the stats, and
 * a `gap`-flagged bar resets everything (SPEC §9 — never z-score across an
 * outage).
 */

const SESSION_OPEN_IST = "09:15"; // NSE cash/F&O session open

export interface BaselineSnapshot {
  volMean: number;
  volStd: number;
  absRetMean: number;
  absRetStd: number;
  samples: number;
}

export class Baselines {
  private readonly volStats: RollingStats;
  private readonly retStats: RollingStats;
  private prevClose: number | null = null;

  constructor(
    baselineWindow: number,
    private readonly openExclusionSec: number,
  ) {
    this.volStats = new RollingStats(baselineWindow);
    this.retStats = new RollingStats(baselineWindow);
  }

  update(bar: Bar): void {
    if (bar.gap) this.reset();
    if (this.isInOpenExclusion(bar.ts)) {
      // keep prevClose current so the first post-exclusion return is 1s-sized
      this.prevClose = bar.c;
      return;
    }
    this.volStats.push(bar.vol);
    if (this.prevClose !== null) {
      this.retStats.push(Math.abs(logReturn(this.prevClose, bar.c)));
    }
    this.prevClose = bar.c;
  }

  reset(): void {
    this.volStats.reset();
    this.retStats.reset();
    this.prevClose = null;
  }

  get ready(): boolean {
    return this.volStats.count >= 2 && this.retStats.count >= 2;
  }

  volZ(vol: number, stdFloor = 0): number {
    return this.volStats.zScore(vol, stdFloor);
  }

  /** trailing volatility of 1s |returns| — the §5.1 normalizer */
  get returnVolatility(): number {
    return this.retStats.std;
  }

  snapshot(): BaselineSnapshot {
    return {
      volMean: this.volStats.average,
      volStd: this.volStats.std,
      absRetMean: this.retStats.average,
      absRetStd: this.retStats.std,
      samples: this.volStats.count,
    };
  }

  private isInOpenExclusion(tsMs: number): boolean {
    const ist = toIst(tsMs);
    const openMin = parseHhMm(SESSION_OPEN_IST);
    const sinceOpenSec = (ist.minutesIst - openMin) * 60;
    return sinceOpenSec >= 0 && sinceOpenSec < this.openExclusionSec;
  }
}
