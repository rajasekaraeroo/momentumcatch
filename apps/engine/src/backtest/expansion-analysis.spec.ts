import { describe, expect, it } from "vitest";
import {
  captureRatio,
  ComponentSeparation,
  labelDoublings,
  LiftTable,
  RunningMean,
  scoreBand,
  SCORE_BAND_ORDER,
} from "./expansion-analysis";

describe("labelDoublings (forward answer key, no look-ahead into the indicator)", () => {
  it("flags a minute when a later high reaches 2× its close within the horizon", () => {
    // close 100 at idx0; high 210 arrives at idx2 (within horizon 3) → doubled
    const series = [
      { c: 100, h: 105, l: 99 },
      { c: 120, h: 130, l: 118 },
      { c: 200, h: 210, l: 190 },
      { c: 90, h: 95, l: 88 },
    ];
    expect(labelDoublings(series, 3, 2)).toEqual([true, false, false, false]);
  });

  it("respects the horizon — a double just outside the window is not counted", () => {
    const series = [
      { c: 100, h: 100, l: 100 },
      { c: 100, h: 100, l: 100 },
      { c: 100, h: 205, l: 100 }, // 2 steps ahead
    ];
    expect(labelDoublings(series, 1, 2)[0]).toBe(false); // horizon 1 can't reach idx2
    expect(labelDoublings(series, 2, 2)[0]).toBe(true); // horizon 2 can
  });

  it("only looks forward (a prior high never labels a later minute)", () => {
    const series = [
      { c: 100, h: 250, l: 100 },
      { c: 100, h: 100, l: 100 },
    ];
    expect(labelDoublings(series, 5, 2)).toEqual([false, false]);
  });
});

describe("scoreBand", () => {
  it("maps scores into the documented bands", () => {
    expect(scoreBand(0)).toBe("00-40");
    expect(scoreBand(39.9)).toBe("00-40");
    expect(scoreBand(40)).toBe("40-55");
    expect(scoreBand(69)).toBe("55-70");
    expect(scoreBand(84)).toBe("70-85");
    expect(scoreBand(85)).toBe("85-100");
    expect(scoreBand(100)).toBe("85-100");
    expect(SCORE_BAND_ORDER).toHaveLength(5);
  });
});

describe("LiftTable (lift = bucket hit-rate ÷ base rate)", () => {
  it("computes base rate, hit rate and lift correctly", () => {
    const t = new LiftTable();
    // high band: 3 fires, 3 doubled
    t.add("high", true);
    t.add("high", true);
    t.add("high", true);
    // low band: 7 fires, 1 doubled
    t.add("low", true);
    for (let i = 0; i < 6; i++) t.add("low", false);
    // base rate = 4 doubled / 10 = 40%
    expect(t.baseRatePct()).toBeCloseTo(40, 5);
    const rows = t.rows(["high", "low"]);
    const high = rows.find((r) => r.label === "high") as (typeof rows)[number];
    const low = rows.find((r) => r.label === "low") as (typeof rows)[number];
    expect(high.hitRatePct).toBeCloseTo(100, 5);
    expect(high.lift).toBeCloseTo(100 / 40, 5); // 2.5×
    expect(low.hitRatePct).toBeCloseTo((1 / 7) * 100, 5);
    expect(low.lift).toBeLessThan(1); // discriminates AGAINST doubling
  });

  it("lift ≈ 1 when a bucket matches the base rate (no discrimination)", () => {
    const t = new LiftTable();
    for (let i = 0; i < 5; i++) t.add("a", true);
    for (let i = 0; i < 5; i++) t.add("a", false);
    expect(t.rows(["a"])[0]?.lift).toBeCloseTo(1, 5);
  });
});

describe("ComponentSeparation", () => {
  it("ranks components by how elevated they are ahead of doublings", () => {
    const s = new ComponentSeparation();
    // velocity clearly higher on doublers; noise component flat
    s.add("velocity", 0.9, true);
    s.add("velocity", 0.8, true);
    s.add("velocity", 0.1, false);
    s.add("velocity", 0.2, false);
    s.add("noise", 0.5, true);
    s.add("noise", 0.5, false);
    const rows = s.rows();
    expect(rows[0]?.name).toBe("velocity"); // largest separation first
    expect(rows[0]?.separation).toBeCloseTo(0.85 - 0.15, 5);
    expect(rows.find((r) => r.name === "noise")?.separation).toBeCloseTo(0, 5);
  });
});

describe("captureRatio (fraction of the ideal trough→peak move reachable)", () => {
  it("is 1 when the crossing is at the trough, 0 at the peak", () => {
    expect(captureRatio(100, 100, 250)).toBeCloseTo(1, 5);
    expect(captureRatio(100, 250, 250)).toBeCloseTo(0, 5);
  });
  it("returns the mid-fraction and clips to [0,1]", () => {
    expect(captureRatio(100, 140, 240)).toBeCloseTo((240 - 140) / (240 - 100), 5);
    expect(captureRatio(100, 260, 250)).toBe(0); // crossing above peak → clipped
    expect(captureRatio(100, 100, 100)).toBe(0); // no move → 0
  });
});

describe("RunningMean", () => {
  it("averages a stream", () => {
    const m = new RunningMean();
    [2, 4, 6].forEach((x) => m.add(x));
    expect(m.count()).toBe(3);
    expect(m.mean()).toBeCloseTo(4, 5);
  });
  it("is 0 when empty", () => {
    expect(new RunningMean().mean()).toBe(0);
  });
});
