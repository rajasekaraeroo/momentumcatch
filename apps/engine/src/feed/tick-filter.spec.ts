import { describe, expect, it } from "vitest";
import type { Tick } from "@momentum-scan/shared";
import { TickFilter } from "./tick-filter";

const tick = (over: Partial<Tick>): Tick => ({
  instrumentKey: "SYNTH_FO|SAMPLE_CE",
  ts: 1_000,
  ltp: 100,
  volume: 5_000,
  ...over,
});

describe("TickFilter (SPEC §3 hygiene)", () => {
  it("accepts fresh ticks", () => {
    const f = new TickFilter();
    expect(f.check(tick({}))).toEqual({ action: "accept", largeSkewMs: undefined });
  });

  it("drops exact duplicates (same ts + ltp + volume)", () => {
    const f = new TickFilter();
    f.check(tick({}));
    expect(f.check(tick({}))).toEqual({ action: "drop-duplicate" });
  });

  it("accepts same-ts ticks when price or volume changed", () => {
    const f = new TickFilter();
    f.check(tick({}));
    expect(f.check(tick({ ltp: 100.5 })).action).toBe("accept");
    expect(f.check(tick({ ltp: 100.5, volume: 5_075 })).action).toBe("accept");
  });

  it("tolerates small out-of-order skew silently", () => {
    const f = new TickFilter();
    f.check(tick({ ts: 10_000 }));
    const v = f.check(tick({ ts: 9_500, ltp: 99 }));
    expect(v.action).toBe("accept");
    expect(v).not.toHaveProperty("largeSkewMs", expect.any(Number));
  });

  it("flags large out-of-order skew", () => {
    const f = new TickFilter();
    f.check(tick({ ts: 10_000 }));
    const v = f.check(tick({ ts: 5_000, ltp: 99 }));
    expect(v.action).toBe("accept");
    expect(v).toMatchObject({ largeSkewMs: 5_000 });
  });

  it("a stale tick does not reset dedupe state", () => {
    const f = new TickFilter();
    f.check(tick({ ts: 10_000 }));
    f.check(tick({ ts: 5_000, ltp: 99 })); // stale, accepted, not tracked
    expect(f.check(tick({ ts: 10_000 }))).toEqual({ action: "drop-duplicate" });
  });

  it("tracks instruments independently", () => {
    const f = new TickFilter();
    f.check(tick({}));
    expect(f.check(tick({ instrumentKey: "SYNTH_FO|SAMPLE_PE" })).action).toBe(
      "accept",
    );
  });
});
