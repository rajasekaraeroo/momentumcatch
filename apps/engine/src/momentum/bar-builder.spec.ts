import { describe, expect, it } from "vitest";
import type { Tick } from "@momentum-scan/shared";
import { BarBuilder } from "./bar-builder";

const KEY = "SYNTH_FO|SAMPLE_CE";
const T0 = 1_782_877_800_000; // second-aligned

const tick = (over: Partial<Tick>): Tick => ({
  instrumentKey: KEY,
  ts: T0,
  ltp: 100,
  ...over,
});

describe("BarBuilder (SPEC §4 1s aggregation)", () => {
  it("aggregates OHLC within a second and closes on the next second", () => {
    const b = new BarBuilder(KEY);
    expect(b.ingest(tick({ ts: T0, ltp: 100 }))).toEqual([]);
    expect(b.ingest(tick({ ts: T0 + 300, ltp: 102 }))).toEqual([]);
    expect(b.ingest(tick({ ts: T0 + 600, ltp: 99 }))).toEqual([]);
    expect(b.ingest(tick({ ts: T0 + 900, ltp: 101 }))).toEqual([]);
    const [bar] = b.ingest(tick({ ts: T0 + 1000, ltp: 101.5 }));
    expect(bar).toMatchObject({
      instrumentKey: KEY,
      ts: T0,
      o: 100,
      h: 102,
      l: 99,
      c: 101,
    });
  });

  it("volume/vwap/oi accounting per bar", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, ltp: 100, volume: 1_000, oi: 50_000 }));
    b.ingest(tick({ ts: T0 + 500, ltp: 102, volume: 1_100, oi: 50_300 }));
    const [bar] = b.ingest(tick({ ts: T0 + 1_000, ltp: 103, volume: 1_400, oi: 50_100 }));
    expect(bar).toMatchObject({ vol: 100, oiDelta: 300, oi: 50_300 });
    // vwap accumulated only for the 100-qty print at 102
    expect(bar?.vwapNum).toBeCloseTo(102 * 100, 10);
    expect(bar?.vwapDen).toBe(100);
    const [bar2] = b.flush(Math.floor(T0 / 1000) + 1);
    expect(bar2).toMatchObject({ vol: 300, oiDelta: -200, oi: 50_100 });
  });

  it("keeps the last depth imbalance snapshot in the bar", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, bidQty: 300, askQty: 100 }));
    b.ingest(tick({ ts: T0 + 400, bidQty: 100, askQty: 300 }));
    const [bar] = b.flush(Math.floor(T0 / 1000));
    expect(bar?.bidAskImbalance).toBeCloseTo(-0.5, 10);
  });

  it("fills trade-less seconds with carry-forward bars", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, ltp: 100 }));
    const bars = b.ingest(tick({ ts: T0 + 3_000, ltp: 105 }));
    expect(bars.map((x) => [x.ts, x.o, x.c, x.vol])).toEqual([
      [T0, 100, 100, 0],
      [T0 + 1_000, 100, 100, 0],
      [T0 + 2_000, 100, 100, 0],
    ]);
  });

  it("drops late ticks for already-closed seconds", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, ltp: 100 }));
    b.ingest(tick({ ts: T0 + 1_000, ltp: 101 }));
    expect(b.ingest(tick({ ts: T0 + 200, ltp: 99 }))).toEqual([]);
    expect(b.lateTicksDropped).toBe(1);
  });

  it("marks the first bar after a gap and stops carry-forward across it", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, ltp: 100, volume: 1_000 }));
    b.flush(Math.floor(T0 / 1000));
    b.markGap();
    // no synthetic bars while gapped
    expect(b.flush(Math.floor(T0 / 1000) + 30)).toEqual([]);
    b.ingest(tick({ ts: T0 + 31_000, ltp: 108, volume: 2_500 }));
    const [bar] = b.flush(Math.floor(T0 / 1000) + 31);
    expect(bar?.gap).toBe(true);
    // cumulative-volume continuity was poisoned by the gap → vol restarts at 0
    expect(bar?.vol).toBe(0);
  });

  it("turns an excessive trade-less stretch into a gap instead of fabricating bars", () => {
    const b = new BarBuilder(KEY);
    b.ingest(tick({ ts: T0, ltp: 100 }));
    const sec = Math.floor(T0 / 1000);
    const bars = b.flush(sec + 120); // > MAX_CARRY_FORWARD_SEC
    expect(bars).toHaveLength(1); // just the real bar, no synthetics
    b.ingest(tick({ ts: T0 + 121_000, ltp: 101 }));
    const [next] = b.flush(sec + 121);
    expect(next?.gap).toBe(true);
  });
});
