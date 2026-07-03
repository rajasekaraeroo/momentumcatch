import { describe, expect, it } from "vitest";
import { RollingStats } from "./rolling-stats";

/** naive reference implementation for cross-checking */
function naive(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

describe("RollingStats (SPEC §4 Welford baselines)", () => {
  it("matches a naive implementation while filling", () => {
    const rs = new RollingStats(5);
    const seen: number[] = [];
    for (const v of [3, 7, 7, 19]) {
      rs.push(v);
      seen.push(v);
      const ref = naive(seen);
      expect(rs.average).toBeCloseTo(ref.mean, 10);
      expect(rs.std).toBeCloseTo(ref.std, 10);
    }
    expect(rs.count).toBe(4);
  });

  it("matches a naive implementation once the window slides", () => {
    const rs = new RollingStats(4);
    const all: number[] = [];
    // deterministic pseudo-random walk
    let x = 100;
    for (let i = 0; i < 200; i++) {
      x += Math.sin(i * 1.7) * 3 + (i % 7) - 3;
      rs.push(x);
      all.push(x);
      const windowVals = all.slice(-4);
      const ref = naive(windowVals);
      expect(rs.average).toBeCloseTo(ref.mean, 8);
      expect(rs.std).toBeCloseTo(ref.std, 8);
    }
    expect(rs.count).toBe(4);
  });

  it("applies the std floor in zScore", () => {
    const rs = new RollingStats(10);
    for (let i = 0; i < 10; i++) rs.push(100); // zero variance
    expect(rs.zScore(105)).toBe(0); // no floor, sd 0 → no information
    expect(rs.zScore(105, 2.5)).toBeCloseTo(2, 10);
  });

  it("resets cleanly", () => {
    const rs = new RollingStats(3);
    rs.push(1);
    rs.push(2);
    rs.reset();
    expect(rs.count).toBe(0);
    expect(rs.average).toBe(0);
    expect(rs.std).toBe(0);
    rs.push(10);
    expect(rs.average).toBe(10);
  });

  it("rejects capacities < 2", () => {
    expect(() => new RollingStats(1)).toThrow();
    expect(() => new RollingStats(2.5)).toThrow();
  });
});
