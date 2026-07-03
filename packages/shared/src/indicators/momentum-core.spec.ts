import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { SignalClassification } from "../types";
import {
  acceleration,
  classify,
  composite,
  flowImbalance,
  oiDeltaRate,
  spreadPenalty,
  underlyingConfirmation,
  velocity,
  volumeBurst,
} from "./momentum-core";
import { EmissionGate } from "./emission";

const KEY = "SYNTH_FO|SAMPLE_CE";

/** bar sequence from closes (1s apart), optional per-bar vol/oiDelta/imb */
function bars(
  closes: number[],
  extra: Partial<Pick<Bar, "vol" | "oiDelta" | "oi" | "bidAskImbalance">>[] = [],
): Bar[] {
  return closes.map((c, i) => ({
    instrumentKey: KEY,
    ts: 1_000_000_000 + i * 1000,
    o: c,
    h: c,
    l: c,
    c,
    vol: extra[i]?.vol ?? 100,
    oiDelta: extra[i]?.oiDelta ?? 0,
    oi: extra[i]?.oi,
    vwapNum: 0,
    vwapDen: 0,
    bidAskImbalance: extra[i]?.bidAskImbalance,
  }));
}

const flat = (n: number, price = 100): number[] => Array(n).fill(price);

describe("velocity (§5.1)", () => {
  it("is ~0 on a flat series and positive on a rise", () => {
    const retVol = 0.001;
    expect(velocity(bars(flat(10)), 5, retVol, 0).normalized).toBe(0);
    const rising = [100, 100, 100, 100, 100, 100.2, 100.4, 100.6, 100.8, 101];
    const v = velocity(bars(rising), 5, retVol, 0);
    expect(v.raw).toBeCloseTo(Math.log(101 / 100), 10);
    expect(v.normalized).toBeGreaterThan(0.9); // ~1% in 5s vs 0.1%/s vol → saturated
  });

  it("is negative on a fall and unavailable with too little history", () => {
    const falling = [100, 100, 100, 100, 100, 99.8, 99.6, 99.4, 99.2, 99];
    expect(velocity(bars(falling), 5, 0.001, 0).normalized).toBeLessThan(-0.9);
    expect(velocity(bars(flat(3)), 5, 0.001, 0).available).toBe(false);
  });

  it("respects the retVol floor (quiet windows don't explode)", () => {
    const rising = [100, 100, 100, 100, 100, 100.05, 100.1, 100.15, 100.2, 100.25];
    const noFloor = velocity(bars(rising), 5, 0.00001, 0);
    const floored = velocity(bars(rising), 5, 0.00001, 0.01);
    expect(Math.abs(noFloor.normalized)).toBe(1);
    expect(Math.abs(floored.normalized)).toBeLessThan(0.1);
  });
});

describe("acceleration (§5.2)", () => {
  it("positive when the rise steepens, negative when it stalls", () => {
    // first 5s: +0.1/s, last 5s: +0.4/s → accelerating
    const accel = [100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.9, 101.3, 101.7, 102.1, 102.5];
    expect(acceleration(bars(accel), 5, 0.002, 0).normalized).toBeGreaterThan(0.3);
    // first 5s: +0.4/s, last 5s: flat → decaying
    const stall = [100, 100.4, 100.8, 101.2, 101.6, 102, 102, 102, 102, 102, 102];
    expect(acceleration(bars(stall), 5, 0.002, 0).normalized).toBeLessThan(-0.3);
  });
});

describe("volumeBurst (§5.3)", () => {
  const base = { volMean: 100, volStd: 20, retVol: 0.001, samples: 300 };
  it("z-scores the fast-window volume against the baseline and caps at ±6", () => {
    const quiet = bars(flat(10)); // vol 100 each = exactly baseline mean
    expect(volumeBurst(quiet, 5, base, 6, 0).normalized).toBeCloseTo(0, 10);
    const burst = bars(flat(10), Array(10).fill({ vol: 800 }));
    const b = volumeBurst(burst, 5, base, 6, 0);
    expect(b.normalized).toBe(1); // capped at +6 → normalized 1
    expect(b.raw).toBe(4000);
  });
  it("is unavailable without baseline samples", () => {
    expect(
      volumeBurst(bars(flat(10)), 5, { ...base, samples: 1 }, 6, 0).available,
    ).toBe(false);
  });
});

describe("flowImbalance §12.8 depth-switch hygiene", () => {
  const mk = (imb: number, depthLevels: number, i: number): Bar => ({
    instrumentKey: KEY,
    ts: 1_000_000_000 + i * 1000,
    o: 100, h: 100, l: 100, c: 100,
    vol: 100, oiDelta: 0, vwapNum: 0, vwapDen: 0,
    bidAskImbalance: imb,
    depthLevels,
  });

  it("restarts the EMA at a D5→D30 switch and warms for 10 bars", () => {
    // 20 D5 bars strongly positive, then a switch to D30 strongly negative
    const series: Bar[] = [
      ...Array.from({ length: 20 }, (_, i) => mk(0.8, 5, i)),
      ...Array.from({ length: 5 }, (_, i) => mk(-0.8, 30, 20 + i)),
    ];
    // only 5 post-switch bars < 10 warmup → unavailable (warming)
    expect(flowImbalance(series, 10).available).toBe(false);

    const warmed: Bar[] = [
      ...Array.from({ length: 20 }, (_, i) => mk(0.8, 5, i)),
      ...Array.from({ length: 12 }, (_, i) => mk(-0.8, 30, 20 + i)),
    ];
    const r = flowImbalance(warmed, 10);
    expect(r.available).toBe(true);
    // pre-switch positive D5 state must NOT leak into the D30 EMA
    expect(r.normalized).toBeLessThan(-0.5);
  });

  it("no switch in window → unchanged D5 behavior", () => {
    const series = Array.from({ length: 20 }, (_, i) => mk(0.6, 5, i));
    const r = flowImbalance(series, 10);
    expect(r.available).toBe(true);
    expect(r.normalized).toBeCloseTo(0.6, 5);
  });
});

describe("flowImbalance (§5.5)", () => {
  it("EMA follows persistent book pressure", () => {
    const buys = bars(flat(20), Array(20).fill({ bidAskImbalance: 0.6 }));
    expect(flowImbalance(buys, 10).normalized).toBeCloseTo(0.6, 5);
    const flip = bars(
      flat(20),
      [...Array(10).fill({ bidAskImbalance: 0.6 }), ...Array(10).fill({ bidAskImbalance: -0.6 })],
    );
    expect(flowImbalance(flip, 10).normalized).toBeLessThan(0);
  });
  it("unavailable without book data", () => {
    expect(flowImbalance(bars(flat(20)), 10).available).toBe(false);
  });
});

describe("spreadPenalty + underlyingConfirmation (§5.5–5.6)", () => {
  it("penalizes blowing-out spreads down to 0.5", () => {
    expect(spreadPenalty(undefined, 1.5)).toBe(1);
    expect(spreadPenalty(0, 1.5)).toBe(1);
    expect(spreadPenalty(0.75, 1.5)).toBe(0.75);
    expect(spreadPenalty(3, 1.5)).toBe(0.5);
  });
  it("CE up + index up confirms; PE up + index up contradicts", () => {
    expect(underlyingConfirmation(1, 1, 1, 0.5, 1.5)).toBe(1.5);
    expect(underlyingConfirmation(1, -1, 1, 0.5, 1.5)).toBe(0.5);
    expect(underlyingConfirmation(-1, -1, -1, 0.5, 1.5)).toBe(0.5); // PE falling while index falls = contra for PE premium down
    expect(underlyingConfirmation(1, -1, -1, 0.5, 1.5)).toBe(1.5); // PE premium up + index falling confirms
  });
});

describe("classification table (§5.4, §5.7)", () => {
  const base = { score: 80, noiseFloor: 50 };
  it("maps the four price/OI quadrants", () => {
    expect(classify({ ...base, priceDirection: 1, oiDelta: 500 })).toBe(
      SignalClassification.DIRECTIONAL_BUILD,
    );
    expect(classify({ ...base, priceDirection: 1, oiDelta: -500 })).toBe(
      SignalClassification.SHORT_COVERING,
    );
    expect(classify({ ...base, priceDirection: -1, oiDelta: 500 })).toBe(
      SignalClassification.DIRECTIONAL_FADE,
    );
    expect(classify({ ...base, priceDirection: -1, oiDelta: -500 })).toBe(
      SignalClassification.LONG_UNWIND,
    );
  });
  it("labels IV-spike-with-flat-underlying as VOL_EVENT", () => {
    expect(
      classify({
        ...base,
        priceDirection: 1,
        oiDelta: 500,
        ivShift: 2,
        underlyingVelocityNorm: 0.05,
      }),
    ).toBe(SignalClassification.VOL_EVENT);
  });
  it("low scores are NOISE", () => {
    expect(classify({ priceDirection: 1, oiDelta: 500, score: 30, noiseFloor: 50 })).toBe(
      SignalClassification.NOISE,
    );
  });
});

describe("composite (§5)", () => {
  const weights = { velocity: 0.35, acceleration: 0.15, volumeBurst: 0.3, flowImbalance: 0.2 };
  const comp = (name: string, normalized: number, available = true) => ({
    name,
    raw: normalized,
    normalized,
    available,
  });

  it("strong aligned components with confirmation clear the 70 threshold", () => {
    const r = composite({
      components: [
        comp("velocity", 0.9),
        comp("acceleration", 0.6),
        comp("volumeBurst", 0.8),
        comp("flowImbalance", 0.5),
      ],
      weights,
      underlyingConfirmation: 1.3,
      spreadPenalty: 1,
    });
    expect(r.direction).toBe(1);
    expect(r.score).toBeGreaterThan(70);
  });

  it("flat market scores ~0", () => {
    const r = composite({
      components: [
        comp("velocity", 0),
        comp("acceleration", 0),
        comp("volumeBurst", 0),
        comp("flowImbalance", 0),
      ],
      weights,
      underlyingConfirmation: 1,
      spreadPenalty: 1,
    });
    expect(r.score).toBeLessThan(1);
  });

  it("renormalizes weights when components are unavailable (§13.2)", () => {
    const withFlow = composite({
      components: [
        comp("velocity", 0.8),
        comp("acceleration", 0.4),
        comp("volumeBurst", 0.7),
        comp("flowImbalance", 0, false),
      ],
      weights,
      underlyingConfirmation: 1,
      spreadPenalty: 1,
    });
    const renormed = composite({
      components: [comp("velocity", 0.8), comp("acceleration", 0.4), comp("volumeBurst", 0.7)],
      weights: { velocity: 0.44, acceleration: 0.19, volumeBurst: 0.37, flowImbalance: 0 },
      underlyingConfirmation: 1,
      spreadPenalty: 1,
    });
    expect(withFlow.score).toBeCloseTo(renormed.score, 1);
  });

  it("poor confirmation and wide spreads suppress the score", () => {
    const strong = [
      comp("velocity", 0.9),
      comp("acceleration", 0.7),
      comp("volumeBurst", 0.9),
      comp("flowImbalance", 0.6),
    ];
    const confirmed = composite({
      components: strong,
      weights,
      underlyingConfirmation: 1.5,
      spreadPenalty: 1,
    });
    const contradicted = composite({
      components: strong,
      weights,
      underlyingConfirmation: 0.5,
      spreadPenalty: 0.5,
    });
    expect(contradicted.score).toBeLessThan(confirmed.score * 0.4);
  });
});

describe("oiDeltaRate (§5.4)", () => {
  it("sums oiDelta over the window and normalizes vs current OI", () => {
    const seq = bars(flat(5), [
      { oiDelta: 100, oi: 100_000 },
      { oiDelta: 200, oi: 100_200 },
      { oiDelta: 300, oi: 100_500 },
      { oiDelta: -100, oi: 100_400 },
      { oiDelta: 500, oi: 100_900 },
    ]);
    const r = oiDeltaRate(seq, 3);
    expect(r.raw).toBe(700);
    expect(r.available).toBe(true);
    expect(r.normalized).toBeCloseTo(700 / 1009, 3);
  });
});

describe("EmissionGate (§5 emission rules)", () => {
  const cfg = { threshold: 70, rearmBelow: 50, cooldownSteps: 60 };
  it("emits on upward cross with liquidity, then holds until rearm + cooldown", () => {
    const g = new EmissionGate(cfg);
    expect(g.update(70, true, 0)).toBe("emit");
    expect(g.update(90, true, 1)).toBe("hold"); // not re-armed
    expect(g.update(45, true, 30)).toBe("hold"); // re-arms here
    expect(g.update(85, true, 40)).toBe("hold"); // armed but inside cooldown
    expect(g.update(85, true, 60)).toBe("emit"); // cooldown elapsed
  });
  it("never emits when the liquidity gate fails", () => {
    const g = new EmissionGate(cfg);
    expect(g.update(95, false, 0)).toBe("hold");
    expect(g.update(95, true, 1)).toBe("emit");
  });
});
