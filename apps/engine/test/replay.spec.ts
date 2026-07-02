import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Tick } from "@momentum-scan/shared";
import { FileReplaySource } from "../src/replay/file-replay.source";
import { TickFilter } from "../src/feed/tick-filter";

const FIXTURE = path.join(__dirname, "fixtures", "sample-ticks.ndjson");

/**
 * Deterministic replay of the committed synthetic sample through the same
 * hygiene layer the live feed uses (SPEC §8, §10) — Stage-1 acceptance path.
 */
describe("FileReplaySource + TickFilter over the committed fixture", () => {
  async function replayAll(): Promise<{
    accepted: Tick[];
    duplicates: number;
    largeSkew: number;
  }> {
    const source = new FileReplaySource(FIXTURE, Infinity);
    const filter = new TickFilter();
    const accepted: Tick[] = [];
    let duplicates = 0;
    let largeSkew = 0;
    await source.start((tick) => {
      const v = filter.check(tick);
      if (v.action === "drop-duplicate") {
        duplicates += 1;
        return;
      }
      if (v.largeSkewMs !== undefined) largeSkew += 1;
      accepted.push(tick);
    });
    return { accepted, duplicates, largeSkew };
  }

  it("replays the exact same tick set every run", async () => {
    const a = await replayAll();
    const b = await replayAll();
    expect(a.accepted).toEqual(b.accepted);
  });

  it("drops the fixture's duplicate and flags its out-of-order tick", async () => {
    const { accepted, duplicates, largeSkew } = await replayAll();
    expect(duplicates).toBe(1);
    expect(largeSkew).toBe(1);
    // 32 lines - 1 duplicate = 31 accepted
    expect(accepted).toHaveLength(31);
    const byInstrument = accepted.reduce<Record<string, number>>((acc, t) => {
      acc[t.instrumentKey] = (acc[t.instrumentKey] ?? 0) + 1;
      return acc;
    }, {});
    expect(byInstrument).toEqual({
      "SYNTH_FO|SAMPLE_CE": 21,
      "SYNTH_INDEX|Sample 50": 10,
    });
  });

  it("preserves file order for accepted ticks", async () => {
    const { accepted } = await replayAll();
    const first = accepted[0];
    expect(first?.instrumentKey).toBe("SYNTH_FO|SAMPLE_CE");
    expect(first?.ltp).toBe(104.8);
  });
});
