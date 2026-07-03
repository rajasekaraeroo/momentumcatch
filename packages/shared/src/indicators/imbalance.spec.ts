import { describe, expect, it } from "vitest";
import type { Tick } from "../types";
import { depthImbalance } from "./imbalance";
import { logReturn } from "./returns";

const base: Tick = { instrumentKey: "SYNTH_FO|SAMPLE_CE", ts: 0, ltp: 100 };

describe("depthImbalance (SPEC §5.5)", () => {
  it("computes (Σbid − Σask)/(Σbid + Σask) from top-5 depth", () => {
    const tick: Tick = {
      ...base,
      depth: {
        bids: [
          { price: 99.9, qty: 300 },
          { price: 99.8, qty: 200 },
        ],
        asks: [{ price: 100.1, qty: 100 }],
      },
    };
    expect(depthImbalance(tick)).toBeCloseTo((500 - 100) / 600, 10);
  });

  it("falls back to best bid/ask quantities without depth", () => {
    expect(depthImbalance({ ...base, bidQty: 900, askQty: 300 })).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("is undefined without any quote information or with empty book", () => {
    expect(depthImbalance(base)).toBeUndefined();
    expect(depthImbalance({ ...base, bidQty: 0, askQty: 0 })).toBeUndefined();
  });

  it("is bounded in [-1, 1]", () => {
    expect(depthImbalance({ ...base, bidQty: 1000, askQty: 0 })).toBe(1);
    expect(depthImbalance({ ...base, bidQty: 0, askQty: 1000 })).toBe(-1);
  });
});

describe("logReturn", () => {
  it("computes ln(to/from)", () => {
    expect(logReturn(100, 105)).toBeCloseTo(Math.log(1.05), 12);
  });
  it("guards non-positive prices", () => {
    expect(logReturn(0, 100)).toBe(0);
    expect(logReturn(100, -1)).toBe(0);
  });
});
