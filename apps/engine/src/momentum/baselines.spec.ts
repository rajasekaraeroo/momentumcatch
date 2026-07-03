import { describe, expect, it } from "vitest";
import type { Bar } from "@momentum-scan/shared";
import { Baselines } from "./baselines";

const KEY = "SYNTH_FO|SAMPLE_CE";
// 2026-07-01 09:25:00 IST — safely past the 09:15+300s open exclusion
const AFTER_EXCLUSION = Date.UTC(2026, 6, 1, 3, 55, 0);
// 2026-07-01 09:17:00 IST — inside the exclusion window
const IN_EXCLUSION = Date.UTC(2026, 6, 1, 3, 47, 0);

const bar = (ts: number, c: number, vol: number, gap = false): Bar => ({
  instrumentKey: KEY,
  ts,
  o: c,
  h: c,
  l: c,
  c,
  vol,
  oiDelta: 0,
  vwapNum: 0,
  vwapDen: 0,
  ...(gap ? { gap } : {}),
});

describe("Baselines (SPEC §4)", () => {
  it("accumulates vol and |return| stats after the exclusion window", () => {
    const b = new Baselines(300, 300);
    b.update(bar(AFTER_EXCLUSION, 100, 50));
    b.update(bar(AFTER_EXCLUSION + 1000, 101, 70));
    b.update(bar(AFTER_EXCLUSION + 2000, 100.5, 60));
    const snap = b.snapshot();
    expect(snap.samples).toBe(3);
    expect(snap.volMean).toBeCloseTo(60, 10);
    expect(b.ready).toBe(true);
    expect(b.returnVolatility).toBeGreaterThan(0);
  });

  it("excludes bars in the first openExclusionSec after 09:15 IST", () => {
    const b = new Baselines(300, 300);
    b.update(bar(IN_EXCLUSION, 100, 500_000)); // opening print — ignored
    expect(b.snapshot().samples).toBe(0);
    b.update(bar(AFTER_EXCLUSION, 101, 50));
    expect(b.snapshot().samples).toBe(1);
    // prevClose was still tracked through the exclusion window
    b.update(bar(AFTER_EXCLUSION + 1000, 102, 55));
    expect(b.snapshot().absRetMean).toBeGreaterThan(0);
  });

  it("resets on a gap-flagged bar (SPEC §9 — no z-scores across outages)", () => {
    const b = new Baselines(300, 300);
    for (let i = 0; i < 10; i++) {
      b.update(bar(AFTER_EXCLUSION + i * 1000, 100 + i * 0.1, 50 + i));
    }
    expect(b.ready).toBe(true);
    b.update(bar(AFTER_EXCLUSION + 60_000, 105, 80, true));
    // the gap bar itself is the first post-reset sample
    expect(b.snapshot().samples).toBe(1);
    expect(b.snapshot().absRetMean).toBe(0); // no prevClose → no return yet
  });

  it("volZ uses the rolling stats with a floor", () => {
    const b = new Baselines(300, 300);
    for (let i = 0; i < 20; i++) {
      b.update(bar(AFTER_EXCLUSION + i * 1000, 100, 50)); // constant vol
    }
    expect(b.volZ(50)).toBe(0);
    expect(b.volZ(90, 10)).toBeCloseTo(4, 10);
  });
});
