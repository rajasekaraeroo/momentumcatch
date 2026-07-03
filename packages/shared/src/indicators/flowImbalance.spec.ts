import { describe, expect, it } from "vitest";
import { simpleImbalance, weightedImbalance, type BookDepth } from "./flowImbalance";

const level = (qty: number) => ({ price: 100, qty });

/** book with `n` levels of `qty` each side, plus overrides at given levels */
function book(
  n: number,
  bidOverrides: Record<number, number> = {},
  askOverrides: Record<number, number> = {},
): BookDepth {
  return {
    bids: Array.from({ length: n }, (_, i) => level(bidOverrides[i] ?? 100)),
    asks: Array.from({ length: n }, (_, i) => level(askOverrides[i] ?? 100)),
  };
}

describe("simpleImbalance (D5 behavior)", () => {
  it("symmetric book → 0", () => {
    expect(simpleImbalance(book(5))).toEqual({ imbalance: 0, lowQuality: false });
  });
  it("bid-heavy book → positive", () => {
    const r = simpleImbalance(book(5, { 0: 500 }));
    expect(r.imbalance).toBeGreaterThan(0);
    expect(r.lowQuality).toBe(false);
  });
  it("empty book → 0 with lowQuality", () => {
    expect(simpleImbalance({ bids: [], asks: [] })).toEqual({
      imbalance: 0,
      lowQuality: true,
    });
  });
  it("one-sided book → ±1 with lowQuality", () => {
    const r = simpleImbalance({ bids: [level(300)], asks: [] });
    expect(r.imbalance).toBe(1);
    expect(r.lowQuality).toBe(true);
  });
});

describe("weightedImbalance (§12.8 D30)", () => {
  const LAMBDA = 0.25;

  it("symmetric book → 0", () => {
    const r = weightedImbalance(book(30), LAMBDA);
    expect(r.imbalance).toBeCloseTo(0, 12);
    expect(r.lowQuality).toBe(false);
  });

  it("touch-heavy bid book → positive", () => {
    const r = weightedImbalance(book(30, { 0: 2_000 }), LAMBDA);
    expect(r.imbalance).toBeGreaterThan(0.1);
  });

  it("size parked at level 25 moves imbalance far less than at level 1", () => {
    const extra = 10_000;
    const atTouch = weightedImbalance(book(30, { 1: 100 + extra }), LAMBDA);
    const parkedDeep = weightedImbalance(book(30, { 25: 100 + extra }), LAMBDA);
    expect(atTouch.imbalance).toBeGreaterThan(0);
    expect(parkedDeep.imbalance).toBeGreaterThan(0);
    // per-level weight ratio is e^6 ≈ 403; the shared (bid+ask) denominator
    // compresses the imbalance ratio to ~40x — still a decisive margin
    expect(atTouch.imbalance / parkedDeep.imbalance).toBeGreaterThan(20);
  });

  it("empty and one-sided books guard division by zero", () => {
    expect(weightedImbalance({ bids: [], asks: [] }, LAMBDA)).toEqual({
      imbalance: 0,
      lowQuality: true,
    });
    const oneSided = weightedImbalance({ bids: [], asks: [level(500)] }, LAMBDA);
    expect(oneSided.imbalance).toBe(-1);
    expect(oneSided.lowQuality).toBe(true);
  });

  it("with lambda 0 it degenerates to the simple imbalance", () => {
    const b = book(5, { 0: 900 }, { 2: 40 });
    expect(weightedImbalance(b, 0).imbalance).toBeCloseTo(
      simpleImbalance(b).imbalance,
      12,
    );
  });
});
