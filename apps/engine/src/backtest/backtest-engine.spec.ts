import { describe, expect, it } from "vitest";
import type { Bar, MomentumEvent } from "@momentum-scan/shared";
import { loadBacktestConfig } from "./config";
import { findRepoRoot, AppConfigService } from "../config/config.service";
import { BacktestEngine, type BtInstrument } from "./backtest-engine";
import { forwardOutcomes, isHit } from "./outcomes";

/**
 * §13.3 STRICT no-lookahead: the poisoned-future fixture. Two candle sets
 * identical through minute T, wildly different after T, must produce
 * IDENTICAL engine output up to and including T.
 */

const CE = "NSE_FO|BT_CE";
const IDX = "INDEX|NIFTY";
const T0 = Date.UTC(2026, 6, 1, 3, 45); // 09:15 IST session open

const instruments = new Map<string, BtInstrument>([
  [CE, { key: CE, side: 1, underlyingKey: IDX, strike: 24_800 }],
]);

function candle(key: string, i: number, c: number, vol: number, oi = 0): Bar {
  return {
    instrumentKey: key,
    ts: T0 + i * 60_000,
    o: c, h: c * 1.001, l: c * 0.999, c,
    vol,
    oiDelta: oi,
    oi: 500_000,
    vwapNum: 0,
    vwapDen: 0,
  };
}

/** deterministic session: 60 quiet minutes, burst at 40–46 */
function makeSession(poisonAfter: number | null): Bar[][] {
  const minutes: Bar[][] = [];
  let ce = 100;
  let idx = 24_800;
  for (let i = 0; i < 60; i++) {
    const burst = i >= 40 && i < 47;
    if (poisonAfter !== null && i > poisonAfter) {
      // wildly different future: crash + huge volume
      ce *= 0.9;
      idx *= 0.99;
      minutes.push([candle(IDX, i, idx, 0), candle(CE, i, ce, 99_999, -5000)]);
      continue;
    }
    // quiet drift with VARYING magnitude so baseline return-vol is realistic
    ce = burst ? ce * 1.02 : ce + 0.08 * Math.sin(i * 1.3) + 0.02 * Math.sin(i * 0.7);
    idx = burst ? idx * 1.002 : idx + Math.sin(i * 1.1);
    minutes.push([
      candle(IDX, i, idx, 0),
      candle(CE, i, ce, burst ? 6_000 : 800, burst ? 400 : 20),
    ]);
  }
  return minutes;
}

function run(minutes: Bar[][], through: number) {
  const repoRoot = findRepoRoot();
  const cfg = loadBacktestConfig(repoRoot);
  const live = new AppConfigService().momentum.lifecycle;
  const events: { key: string; ts: number; score: number }[] = [];
  const engine = new BacktestEngine(
    cfg,
    {
      decayWeights: live.decayWeights,
      volumeFadeFloorRatio: live.volumeFadeFloorRatio,
      pullbackAtrK: live.pullbackAtrK,
      fadingAt: live.fadingAt,
      reigniteBelow: live.reigniteBelow,
      deadAt: live.deadAt,
      deadScoreFloor: live.deadScoreFloor,
      maxEpisodeSteps: live.maxEpisodeSec,
    },
    instruments,
    {
      onEvent: (e: MomentumEvent) =>
        events.push({ key: e.instrumentKey, ts: e.ts, score: Math.round(e.score * 1000) / 1000 }),
    },
  );
  engine.newSession();
  for (let i = 0; i <= through; i++) {
    engine.step(T0 + i * 60_000, minutes[i] as Bar[]);
  }
  return events;
}

describe("BacktestEngine no-lookahead (SPEC §13.3 poisoned-future fixture)", () => {
  it("emits a momentum event on the synthetic burst after warm-up", () => {
    const events = run(makeSession(null), 59);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0] as { ts: number };
    // warm-up: nothing before candle 30
    expect(first.ts).toBeGreaterThanOrEqual(T0 + 30 * 60_000);
    // the burst starts at minute 40 — the event belongs to it
    expect(first.ts).toBeGreaterThanOrEqual(T0 + 40 * 60_000);
  });

  it("output through minute T is identical when the future is poisoned", () => {
    const T = 44; // mid-burst — an event has fired by here
    const clean = run(makeSession(null), T);
    const poisoned = run(makeSession(T), T);
    expect(clean.length).toBeGreaterThanOrEqual(1);
    expect(poisoned).toEqual(clean);
  });

  it("poisoned future diverges only AFTER T", () => {
    const T = 44;
    const clean = run(makeSession(null), 59);
    const poisoned = run(makeSession(T), 59);
    const cleanThroughT = clean.filter((e) => e.ts <= T0 + T * 60_000);
    const poisonedThroughT = poisoned.filter((e) => e.ts <= T0 + T * 60_000);
    expect(poisonedThroughT).toEqual(cleanThroughT);
  });
});

describe("forwardOutcomes (§13.4)", () => {
  it("computes horizon returns, MFE/MAE and time-to-peak", () => {
    const closes = [102, 104, 103, 99, 101, 105, 104, 103, 102, 101, 100, 100, 100, 100, 100];
    const o = forwardOutcomes(100, 1, closes, [1, 3, 5, 10, 15]);
    expect(o.fwdReturns["1"]).toBeCloseTo(0.02, 10);
    expect(o.fwdReturns["5"]).toBeCloseTo(0.01, 10);
    expect(o.mfe).toBeCloseTo(0.05, 10);
    expect(o.mae).toBeCloseTo(0.01, 10);
    expect(o.timeToPeakMin).toBe(6);
    expect(isHit(o, 2)).toBe(true);
    expect(isHit(o, 6)).toBe(false);
  });
  it("direction −1 flips favorability", () => {
    const o = forwardOutcomes(100, -1, [95, 90, 105], [1, 3]);
    expect(o.fwdReturns["1"]).toBeCloseTo(0.05, 10);
    expect(o.mfe).toBeCloseTo(0.1, 10);
    expect(o.mae).toBeCloseTo(0.05, 10);
  });
  it("null returns beyond session end", () => {
    const o = forwardOutcomes(100, 1, [101], [1, 3, 5, 10, 15]);
    expect(o.fwdReturns["3"]).toBeNull();
  });
});
