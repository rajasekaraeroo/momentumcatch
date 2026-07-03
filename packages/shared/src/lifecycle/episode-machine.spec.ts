import { describe, expect, it } from "vitest";
import { EpisodeState, LifecycleEventType } from "../types";
import {
  EpisodeMachine,
  type EpisodeStepInput,
  type LifecycleStepConfig,
} from "./episode-machine";

/** live-shaped config (momentum.yaml lifecycle defaults, 1s steps) */
const cfg: LifecycleStepConfig = {
  decayWeights: {
    accelerationReversal: 0.25,
    volumeFade: 0.2,
    extremeStall: 0.2,
    pullbackDepth: 0.15,
    flowFlip: 0.1,
    underlyingDivergence: 0.1,
  },
  accelReversalStepsFull: 5,
  volumeFadeFloorRatio: 0.3,
  stallBudgetSteps: 45,
  pullbackAtrK: 1.5,
  flowFlipStepsFull: 10,
  peakConfirmSteps: 10,
  fadingAt: 50,
  reigniteBelow: 30,
  deadAt: 75,
  deadScoreFloor: 35,
  maxEpisodeSteps: 900,
};

const T0 = 1_000_000_000_000;

function machine(direction: 1 | -1 = 1): EpisodeMachine {
  return new EpisodeMachine(cfg, {
    id: "ep-1",
    instrumentKey: "SYNTH_FO|SAMPLE_CE",
    direction,
    openedAt: T0,
    score: 75,
    premium: 100,
    windowVol: 1000,
    velocity: 0.9,
  });
}

const step = (i: number, over: Partial<EpisodeStepInput>): EpisodeStepInput => ({
  ts: T0 + (i + 1) * 1000,
  score: 75,
  premium: 100,
  windowVol: 1000,
  acceleration: 0.2,
  flowImbalance: 0.3,
  underlyingConfirmation: 1.2,
  atr: 0.5,
  ...over,
});

/** drive the machine through a scripted sequence, collecting transitions */
function run(m: EpisodeMachine, inputs: EpisodeStepInput[]) {
  const events: { type: LifecycleEventType; i: number }[] = [];
  inputs.forEach((input, i) => {
    for (const t of m.step(input).transitions) events.push({ type: t.type, i });
  });
  return events;
}

describe("EpisodeMachine (SPEC §14.5 synthetic episodes)", () => {
  it("clean impulse-then-fade: BUILDING → PEAK → FADING → DEAD", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    // impulse: rising premium, new score highs
    for (let i = 0; i < 10; i++) {
      script.push(step(i, { premium: 100 + i, score: 75 + i, acceleration: 0.5 }));
    }
    // plateau: score stops making highs, still strong → PEAK after 10 steps
    for (let i = 10; i < 25; i++) {
      script.push(step(i, { premium: 110, score: 80, acceleration: 0.05 }));
    }
    // fade: volume dries to 0.2x, premium retraces, acceleration flips
    for (let i = 25; i < 90; i++) {
      script.push(
        step(i, {
          premium: 110 - (i - 24) * 0.15,
          score: Math.max(40, 80 - (i - 24) * 0.8),
          windowVol: 200,
          acceleration: -0.4,
          flowImbalance: -0.4,
          underlyingConfirmation: 0.8,
        }),
      );
    }
    const events = run(m, script);
    expect(events.map((e) => e.type)).toEqual([
      LifecycleEventType.MOMENTUM_FADING,
      LifecycleEventType.MOMENTUM_DEAD,
    ]);
    expect(m.episode.state).toBe(EpisodeState.DEAD);
    // dies ~10 steps after FADING — a modest fraction of the move given back,
    // which is exactly the §14.5 claim vs the naive score<40 rule
    expect(m.episode.givebackPct).toBeGreaterThan(0.05);
    expect(m.episode.givebackPct).toBeLessThan(0.5);
    const atFading = m.fadingGiveback();
    expect(atFading).not.toBeNull();
    expect(atFading as number).toBeLessThanOrEqual(m.episode.givebackPct as number);
    // fading fired before death, with evidence populated
    expect(m.episode.decayEvidence.volumeFade).toBeGreaterThan(0.9);
    expect(m.episode.decayEvidence.accelerationReversal).toBe(1);
  });

  it("V-reversal: sharp retracement drives FADING then DEAD quickly", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    for (let i = 0; i < 8; i++) {
      script.push(step(i, { premium: 100 + i * 2, score: 75 + i, acceleration: 0.6 }));
    }
    for (let i = 8; i < 20; i++) script.push(step(i, { premium: 114, score: 82 }));
    // violent reversal: deep pullback vs ATR, flow flips hard, score collapses
    for (let i = 20; i < 40; i++) {
      script.push(
        step(i, {
          premium: 114 - (i - 19) * 1.2,
          score: 82 - (i - 19) * 4,
          acceleration: -0.9,
          flowImbalance: -0.8,
          windowVol: 900,
          underlyingConfirmation: 0.6,
        }),
      );
    }
    const events = run(m, script);
    expect(events.map((e) => e.type)).toEqual([
      LifecycleEventType.MOMENTUM_FADING,
      LifecycleEventType.MOMENTUM_DEAD,
    ]);
    const fade = events[0] as { i: number };
    const dead = events[1] as { i: number };
    expect(dead.i - fade.i).toBeLessThan(12); // V-shape dies fast
  });

  it("re-ignition: FADING reverts to PEAK on decay collapse + new score high", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    for (let i = 0; i < 8; i++) {
      script.push(step(i, { premium: 100 + i, score: 75 + i }));
    }
    for (let i = 8; i < 20; i++) script.push(step(i, { premium: 107, score: 80 }));
    // stall long enough to trip FADING (extreme stall + volume fade)
    for (let i = 20; i < 70; i++) {
      script.push(
        step(i, { premium: 106.9, score: 66, windowVol: 250, acceleration: -0.2 }),
      );
    }
    // fresh leg: new premium extremes, new score highs, strong volume
    for (let i = 70; i < 90; i++) {
      script.push(
        step(i, {
          premium: 107 + (i - 69) * 0.8,
          score: 84 + (i - 69),
          windowVol: 1500,
          acceleration: 0.7,
          flowImbalance: 0.6,
        }),
      );
    }
    const events = run(m, script);
    expect(events.map((e) => e.type)).toContain(LifecycleEventType.MOMENTUM_FADING);
    expect(events.map((e) => e.type)).toContain(LifecycleEventType.MOMENTUM_REIGNITED);
    expect(m.episode.state).toBe(EpisodeState.PEAK);
  });

  it("slow bleed: stall + fade accumulate to FADING and eventually DEAD without a crash", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    for (let i = 0; i < 6; i++) script.push(step(i, { premium: 100 + i, score: 75 + i }));
    for (let i = 6; i < 18; i++) script.push(step(i, { premium: 105.5, score: 79 }));
    // long slow drip: tiny retrace per step, volume slowly dying
    for (let i = 18; i < 220; i++) {
      const t = i - 17;
      script.push(
        step(i, {
          premium: 105.5 - t * 0.02,
          score: Math.max(36, 79 - t * 0.2),
          windowVol: Math.max(150, 1000 - t * 8),
          acceleration: -0.1,
          flowImbalance: -0.1,
          underlyingConfirmation: 0.95,
        }),
      );
    }
    const events = run(m, script);
    expect(events.map((e) => e.type)).toEqual([
      LifecycleEventType.MOMENTUM_FADING,
      LifecycleEventType.MOMENTUM_DEAD,
    ]);
  });

  it("one-print spike: a single anomalous print does not fake a new extreme trend", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    for (let i = 0; i < 8; i++) script.push(step(i, { premium: 100 + i, score: 75 + i }));
    for (let i = 8; i < 18; i++) script.push(step(i, { premium: 107, score: 80 }));
    // one wild print far above, then back — stall clock resets only once
    script.push(step(18, { premium: 118, score: 80 }));
    for (let i = 19; i < 80; i++) {
      script.push(
        step(i, { premium: 106.5, score: 60, windowVol: 250, acceleration: -0.3 }),
      );
    }
    const events = run(m, script);
    // the spike widens the peak so pullback saturates → FADING fires
    expect(events.map((e) => e.type)).toContain(LifecycleEventType.MOMENTUM_FADING);
    expect(m.episode.peak.premiumExtreme).toBe(118);
    expect(m.episode.decayEvidence.pullbackDepth).toBe(1);
  });

  it("hard timeout kills a zombie episode", () => {
    const m = machine();
    const script: EpisodeStepInput[] = [];
    for (let i = 0; i < 905; i++) {
      // keeps making marginal new highs so no natural transition triggers
      script.push(step(i, { premium: 100 + i * 0.01, score: 75 + (i % 3) * 0.01 }));
    }
    const events = run(m, script);
    expect(events[events.length - 1]?.type).toBe(LifecycleEventType.MOMENTUM_DEAD);
  });

  it("backtest variant: flowFlip weight renormalized away when flow is absent", () => {
    const m = machine();
    // no flowImbalance provided → decay must still reach 100 when all other
    // components saturate
    for (let i = 0; i < 20; i++) m.step(step(i, { premium: 100 + i, score: 76 + i }));
    let out;
    for (let i = 20; i < 120; i++) {
      out = m.step(
        step(i, {
          premium: 90,
          score: 55,
          windowVol: 100,
          acceleration: -0.5,
          flowImbalance: undefined,
          underlyingConfirmation: 0.5,
          atr: 0.5,
        }),
      );
      if (m.episode.state === EpisodeState.DEAD) break;
    }
    expect(out?.episode.decayScore).toBeGreaterThan(90);
  });

  it("works symmetrically for direction −1 (PE premium falling = favorable)", () => {
    const m = new EpisodeMachine(cfg, {
      id: "ep-2",
      instrumentKey: "SYNTH_FO|SAMPLE_PE",
      direction: -1,
      openedAt: T0,
      score: 75,
      premium: 100,
      windowVol: 1000,
      velocity: -0.9,
    });
    // favorable = premium falling; then a retrace UP should build pullback
    for (let i = 0; i < 10; i++) m.step(step(i, { premium: 100 - i, score: 75 + i }));
    for (let i = 10; i < 22; i++) m.step(step(i, { premium: 91, score: 82 }));
    let lastDecay = 0;
    for (let i = 22; i < 40; i++) {
      const out = m.step(
        step(i, { premium: 91 + (i - 21) * 0.3, score: 70, acceleration: 0.5 }),
      );
      lastDecay = out.episode.decayScore;
    }
    expect(m.episode.peak.premiumExtreme).toBe(91);
    expect(m.episode.decayEvidence.pullbackDepth).toBe(1);
    expect(lastDecay).toBeGreaterThan(30);
  });
});
