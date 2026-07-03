import { describe, expect, it } from "vitest";
import type { Tick } from "@momentum-scan/shared";
import type { StreamEntry } from "../streams/tick-stream";
import { Aggregator } from "./aggregator";

const KEY = "SYNTH_FO|SAMPLE_CE";
const T0 = Date.UTC(2026, 6, 1, 3, 55, 0); // 09:25 IST, past open exclusion

const tickEntry = (over: Partial<Tick>): StreamEntry => ({
  kind: "tick",
  tick: { instrumentKey: KEY, ts: T0, ltp: 100, ...over },
});

describe("Aggregator (SPEC §4 orchestration)", () => {
  it("builds bars from stream entries and updates baselines", () => {
    const agg = new Aggregator({ baselineWindow: 300, openExclusionSec: 300 });
    const bars = agg.handleEntries(KEY, [
      tickEntry({ ts: T0, ltp: 100, volume: 1000 }),
      tickEntry({ ts: T0 + 400, ltp: 101, volume: 1050 }),
      tickEntry({ ts: T0 + 1200, ltp: 102, volume: 1100 }),
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ o: 100, c: 101, vol: 50 });
    expect(agg.baselineSnapshot(KEY).samples).toBe(1);
    expect(agg.barsClosedTotal).toBe(1);
  });

  it("gap entries poison the builder and reset baselines via the flagged bar", () => {
    const agg = new Aggregator({ baselineWindow: 300, openExclusionSec: 300 });
    for (let i = 0; i < 5; i++) {
      agg.handleEntries(KEY, [tickEntry({ ts: T0 + i * 1000, ltp: 100 + i })]);
    }
    expect(agg.baselineSnapshot(KEY).samples).toBe(4);
    agg.handleEntries(KEY, [{ kind: "gap", ts: T0 + 5_000 }]);
    expect(agg.gapsTotal).toBe(1);
    const bars = agg.handleEntries(KEY, [
      tickEntry({ ts: T0 + 20_000, ltp: 110 }),
      tickEntry({ ts: T0 + 21_000, ltp: 111 }),
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.gap).toBe(true);
    expect(agg.baselineSnapshot(KEY).samples).toBe(1); // reset happened
  });

  it("flush closes aged buckets per instrument", () => {
    const agg = new Aggregator({ baselineWindow: 300, openExclusionSec: 300 });
    agg.handleEntries(KEY, [tickEntry({ ts: T0, ltp: 100 })]);
    expect(agg.flush(KEY, Math.floor(T0 / 1000))).toHaveLength(1);
    expect(agg.flush(KEY, Math.floor(T0 / 1000))).toHaveLength(0); // idempotent
    expect(agg.activeInstruments()).toEqual([KEY]);
  });
});
