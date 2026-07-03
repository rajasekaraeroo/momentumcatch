import { describe, expect, it } from "vitest";
import type { Bar, MomentumEvent } from "@momentum-scan/shared";
import { AppConfigService } from "../config/config.service";
import { SignalBus } from "../signals/signal-bus";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { MomentumService } from "./momentum.service";

/**
 * Integration of the shared §5 math with the live service: a synthetic
 * burst on a CE with a rising index must emit exactly one MomentumEvent
 * (hysteresis suppresses repeats), with evidence components attached.
 */

const CE = "SYNTH_FO|SAMPLE_CE";
const INDEX = "SYNTH_INDEX|Sample 50";
const T0 = Date.UTC(2026, 6, 1, 5, 0, 0); // 10:30 IST — clear of open exclusion

function bar(key: string, i: number, c: number, vol: number, imb = 0.4): Bar {
  return {
    instrumentKey: key,
    ts: T0 + i * 1000,
    o: c,
    h: c,
    l: c,
    c,
    vol,
    oiDelta: key === CE ? 40 : 0,
    oi: key === CE ? 500_000 : undefined,
    vwapNum: 0,
    vwapDen: 0,
    bidAskImbalance: key === CE ? imb : undefined,
    spreadPct: key === CE ? 0.3 : undefined,
  };
}

function makeService(): { svc: MomentumService; events: MomentumEvent[]; bus: SignalBus } {
  const config = new AppConfigService();
  const registry = new InstrumentRegistry();
  registry.registerIndex(INDEX, "NIFTY");
  registry.registerOption(CE, {
    side: 1,
    underlyingKey: INDEX,
    underlying: "NIFTY",
    strike: 24_800,
    expiry: "2026-07-09",
  });
  const bus = new SignalBus();
  const events: MomentumEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { svc: new MomentumService(config, registry, bus), events, bus };
}

const baseline = (volMean: number, volStd: number, absRetStd: number) => ({
  volMean,
  volStd,
  absRetMean: 0,
  absRetStd,
  samples: 300,
});

describe("MomentumService (§5 live engine)", () => {
  it("emits exactly one event for a sustained burst, with evidence", () => {
    const { svc, events } = makeService();
    const ceBase = baseline(100, 20, 0.0005);
    const idxBase = baseline(0, 0, 0.00005);

    // 60s of quiet drift for both instruments
    let ce = 100;
    let idx = 24_800;
    for (let i = 0; i < 60; i++) {
      svc.onBars(INDEX, [bar(INDEX, i, idx, 0)], idxBase);
      svc.onBars(CE, [bar(CE, i, ce, 100)], ceBase);
    }
    expect(events).toHaveLength(0);

    // 10s burst: premium +0.7%/s on 6x volume, index rising too
    for (let i = 60; i < 70; i++) {
      ce *= 1.007;
      idx *= 1.0006;
      svc.onBars(INDEX, [bar(INDEX, i, idx, 0)], idxBase);
      svc.onBars(CE, [bar(CE, i, ce, 600)], ceBase);
    }
    expect(events).toHaveLength(1);
    const e = events[0] as MomentumEvent;
    expect(e.instrumentKey).toBe(CE);
    expect(e.direction).toBe(1);
    expect(e.score).toBeGreaterThanOrEqual(70);
    expect(e.components.length).toBeGreaterThan(4);
    expect(e.components.find((c) => c.name === "velocity")?.normalized).toBeGreaterThan(0.5);
    expect(e.underlyingConfirmation).toBeGreaterThan(1);

    // continued strength does not re-emit (hysteresis)
    for (let i = 70; i < 80; i++) {
      ce *= 1.006;
      idx *= 1.0005;
      svc.onBars(INDEX, [bar(INDEX, i, idx, 0)], idxBase);
      svc.onBars(CE, [bar(CE, i, ce, 550)], ceBase);
    }
    expect(events).toHaveLength(1);
    expect(svc.latestSnapshot(CE)?.score).toBeGreaterThan(0);
  });

  it("does not emit when the liquidity gate fails (thin volume)", () => {
    const { svc, events } = makeService();
    const ceBase = baseline(2, 1, 0.0005);
    const idxBase = baseline(0, 0, 0.00005);
    let ce = 100;
    let idx = 24_800;
    for (let i = 0; i < 70; i++) {
      const burst = i >= 60;
      if (burst) {
        ce *= 1.007;
        idx *= 1.0006;
      }
      svc.onBars(INDEX, [bar(INDEX, i, idx, 0)], idxBase);
      // fast-window volume stays below minVol5s (50)
      svc.onBars(CE, [bar(CE, i, ce, burst ? 8 : 2)], ceBase);
    }
    expect(events).toHaveLength(0);
  });
});
