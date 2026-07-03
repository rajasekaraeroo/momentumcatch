import type { Bar, Direction } from "../types";
import { SignalClassification } from "../types";
import { logReturn } from "./returns";

/**
 * Momentum signal components + composite score (SPEC §5), written window-
 * agnostic: the live engine calls this with 1-second bars (fast=5, slow=30,
 * baseline=300), the backtester with 1-minute candles (fast=1, slow=3,
 * baseline=30). Components that are unavailable at a given resolution are
 * reported `available: false` and their composite weights renormalized
 * (SPEC §13.2). Pure functions only — no I/O, no clocks.
 */

export interface MomentumWindows {
  fast: number; // steps (5s live / 1 candle backtest)
  slow: number; // steps (30s / 3 candles)
  oi: number; // steps (60s / 3 candles)
}

export interface MomentumWeights {
  velocity: number;
  acceleration: number;
  volumeBurst: number;
  flowImbalance: number; // 0 in backtest configs
}

export interface BaselineInputs {
  /** rolling mean of per-step traded volume */
  volMean: number;
  /** rolling std of per-step traded volume */
  volStd: number;
  /** rolling std of per-step |log return| — the §5.1 normalizer */
  retVol: number;
  /** samples in the baseline window */
  samples: number;
}

export interface ComponentResult {
  name: string;
  raw: number;
  normalized: number;
  available: boolean;
}

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** logistic squash for the composite (SPEC §5 "σ"); gain spreads w·x ∈ [-1,1]
 *  over a usable 0–100 range */
const SIGMOID_GAIN = 4;
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-SIGMOID_GAIN * x));

/** z-values beyond ~3σ are treated as saturated when normalizing to [-1,1] */
const Z_SATURATION = 3;

const last = (bars: Bar[]): Bar | undefined => bars[bars.length - 1];

/** §5.1 premium velocity: log-return over `steps`, normalized by trailing
 *  per-step return volatility scaled to the window (√n). */
export function velocity(
  bars: Bar[],
  steps: number,
  retVol: number,
  retVolFloor: number,
): ComponentResult {
  const name = "velocity";
  if (bars.length < steps + 1) {
    return { name, raw: 0, normalized: 0, available: false };
  }
  const from = bars[bars.length - 1 - steps] as Bar;
  const to = last(bars) as Bar;
  const r = logReturn(from.c, to.c);
  const vol = Math.max(retVol, retVolFloor) * Math.sqrt(steps);
  const z = vol > 0 ? r / vol : 0;
  return { name, raw: r, normalized: clamp(z / Z_SATURATION, -1, 1), available: true };
}

/** §5.2 premium acceleration: fast-window velocity now vs one fast-window ago. */
export function acceleration(
  bars: Bar[],
  fastSteps: number,
  retVol: number,
  retVolFloor: number,
): ComponentResult {
  const name = "acceleration";
  if (bars.length < 2 * fastSteps + 1) {
    return { name, raw: 0, normalized: 0, available: false };
  }
  const now = velocity(bars, fastSteps, retVol, retVolFloor);
  const prev = velocity(
    bars.slice(0, bars.length - fastSteps),
    fastSteps,
    retVol,
    retVolFloor,
  );
  const raw = now.raw - prev.raw;
  const vol = Math.max(retVol, retVolFloor) * Math.sqrt(fastSteps);
  const z = vol > 0 ? raw / vol : 0;
  return { name, raw, normalized: clamp(z / Z_SATURATION, -1, 1), available: true };
}

/** §5.3 volume burst: z of the fast-window volume sum vs the per-step
 *  baseline (mean·n, std·√n), capped at ±`zCap`. */
export function volumeBurst(
  bars: Bar[],
  steps: number,
  base: BaselineInputs,
  zCap: number,
  volStdFloor: number,
): ComponentResult {
  const name = "volumeBurst";
  if (bars.length < steps || base.samples < 2) {
    return { name, raw: 0, normalized: 0, available: false };
  }
  const vol = bars.slice(-steps).reduce((a, b) => a + b.vol, 0);
  const mean = base.volMean * steps;
  const std = Math.max(base.volStd, volStdFloor) * Math.sqrt(steps);
  const z = std > 0 ? clamp((vol - mean) / std, -zCap, zCap) : 0;
  return { name, raw: vol, normalized: clamp(z / zCap, -1, 1), available: true };
}

/** §5.4 OI delta rate over the OI window (raw contracts; the classification
 *  table consumes the sign). */
export function oiDeltaRate(bars: Bar[], steps: number): ComponentResult {
  const name = "oiDeltaRate";
  if (bars.length < steps) return { name, raw: 0, normalized: 0, available: false };
  const delta = bars.slice(-steps).reduce((a, b) => a + b.oiDelta, 0);
  const lastOi = last(bars)?.oi;
  const norm = lastOi && lastOi > 0 ? clamp(delta / (0.01 * lastOi), -1, 1) : 0;
  return { name, raw: delta, normalized: norm, available: lastOi !== undefined };
}

/**
 * §5.5 order-flow imbalance: EMA of per-bar book imbalance over ~`steps`.
 * §12.8 EMA hygiene: a change in `depthLevels` between bars marks a D5↔D30
 * switch (focus-pool promotion/demotion) — the smoother restarts at the
 * switch and reports unavailable for `warmupSteps` bars (never mixes D5 and
 * D30 states).
 */
export function flowImbalance(
  bars: Bar[],
  steps: number,
  warmupSteps = 10,
): ComponentResult {
  const name = "flowImbalance";
  let withImb = bars.slice(-3 * steps).filter((b) => b.bidAskImbalance !== undefined);
  // cut the window at the most recent depth-basis switch
  const lastBasis = withImb[withImb.length - 1]?.depthLevels;
  let switchIdx = -1;
  for (let i = withImb.length - 1; i >= 0; i--) {
    if ((withImb[i] as Bar).depthLevels !== lastBasis) {
      switchIdx = i;
      break;
    }
  }
  if (switchIdx >= 0) {
    withImb = withImb.slice(switchIdx + 1);
    if (withImb.length < warmupSteps) {
      return { name, raw: 0, normalized: 0, available: false }; // warming
    }
  }
  if (withImb.length < 2) return { name, raw: 0, normalized: 0, available: false };
  const alpha = 2 / (steps + 1);
  let ema = withImb[0]?.bidAskImbalance ?? 0;
  for (const b of withImb.slice(1)) ema = alpha * (b.bidAskImbalance as number) + (1 - alpha) * ema;
  return { name, raw: ema, normalized: clamp(ema, -1, 1), available: true };
}

/** §5.5 spread penalty: 1 (tight) → 0.5 (at/over the gate ceiling). */
export function spreadPenalty(spreadPct: number | undefined, maxSpreadPct: number): number {
  if (spreadPct === undefined) return 1;
  return 1 - 0.5 * clamp(spreadPct / maxSpreadPct, 0, 1);
}

/** §5.6 underlying confirmation → multiplier in [min,max]. `side` +1 for CE,
 *  −1 for PE; alignment of the option's move with the underlying's move. */
export function underlyingConfirmation(
  optionDirection: Direction,
  side: 1 | -1,
  underlyingVelocityNorm: number,
  min: number,
  max: number,
): number {
  const alignment = optionDirection * side * underlyingVelocityNorm;
  return clamp(1 + 0.5 * alignment, min, max);
}

/** §5.4 + §5.7 classification table (descriptive labels only). */
export function classify(input: {
  priceDirection: Direction;
  oiDelta: number;
  score: number;
  noiseFloor: number;
  ivShift?: number; // 60s IV change when greeks available
  underlyingVelocityNorm?: number;
}): SignalClassification {
  if (input.score < input.noiseFloor) return SignalClassification.NOISE;
  // §5.7: premium moving with IV spiking while the underlying is flat is a
  // vol event, not directional momentum
  if (
    input.ivShift !== undefined &&
    input.underlyingVelocityNorm !== undefined &&
    Math.abs(input.ivShift) > 0.5 &&
    Math.abs(input.underlyingVelocityNorm) < 0.15
  ) {
    return SignalClassification.VOL_EVENT;
  }
  const oiUp = input.oiDelta > 0;
  if (input.priceDirection > 0) {
    return oiUp
      ? SignalClassification.DIRECTIONAL_BUILD // long buildup
      : SignalClassification.SHORT_COVERING;
  }
  return oiUp
    ? SignalClassification.DIRECTIONAL_FADE // short buildup pattern
    : SignalClassification.LONG_UNWIND;
}

export interface CompositeInput {
  components: ComponentResult[]; // velocity, acceleration, volumeBurst, flowImbalance
  weights: MomentumWeights;
  underlyingConfirmation: number;
  spreadPenalty: number;
}

export interface CompositeResult {
  score: number; // 0–100 magnitude
  direction: Direction;
  weighted: number; // Σ w·c before squash, for evidence
}

/** §5 composite: 100·σ(Σw·c)·confirmation·penalty, magnitude with direction
 *  from the velocity sign, weights renormalized over available components. */
export function composite(input: CompositeInput): CompositeResult {
  const weightFor = (name: string): number =>
    name === "velocity"
      ? input.weights.velocity
      : name === "acceleration"
        ? input.weights.acceleration
        : name === "volumeBurst"
          ? input.weights.volumeBurst
          : name === "flowImbalance"
            ? input.weights.flowImbalance
            : 0;

  const avail = input.components.filter((c) => c.available && weightFor(c.name) > 0);
  const totalW = avail.reduce((a, c) => a + weightFor(c.name), 0);
  const vel = input.components.find((c) => c.name === "velocity");
  const direction: Direction = (vel?.normalized ?? 0) >= 0 ? 1 : -1;
  if (totalW === 0) return { score: 0, direction, weighted: 0 };

  // renormalize, then fold direction: components are signed with price
  // direction; magnitude of momentum = |weighted sum|
  const weighted = avail.reduce(
    (a, c) => a + (weightFor(c.name) / totalW) * c.normalized,
    0,
  );
  const magnitude = 100 * Math.abs(2 * (sigmoid(Math.abs(weighted)) - 0.5));
  const score = clamp(
    magnitude * input.underlyingConfirmation * input.spreadPenalty,
    0,
    100,
  );
  return { score, direction: weighted >= 0 ? 1 : -1, weighted };
}
