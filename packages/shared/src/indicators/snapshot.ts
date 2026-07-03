import type { Bar, ComponentEvidence, Direction, MomentumSnapshot } from "../types";
import { atr } from "./atr";
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
  type BaselineInputs,
  type MomentumWeights,
  type MomentumWindows,
} from "./momentum-core";

/**
 * One full §5 evaluation for one option instrument at one step. Shared by
 * the live 1s engine and the 1m backtester — only the window/weight config
 * and the bar arrays differ. Pure.
 */

export interface SnapshotConfig {
  windows: MomentumWindows;
  weights: MomentumWeights;
  volumeBurstZCap: number; // §5.3, default 6
  confirmationMin: number; // §5.6, default 0.5
  confirmationMax: number; // default 1.5
  maxSpreadPct: number; // liquidity gate ceiling
  minWindowVol: number; // liquidity gate floor (fast-window volume)
  noiseFloor: number; // classification NOISE cutoff (use rearmBelow)
  retVolFloor: number; // std floors against quiet/opening windows
  volStdFloor: number;
}

export interface SnapshotInput {
  instrumentKey: string;
  ts: number;
  side: 1 | -1; // CE +1 / PE −1
  bars: Bar[]; // trailing window, oldest→newest, step-spaced
  underlyingBars: Bar[]; // same step spacing
  baseline: BaselineInputs;
  underlyingBaseline: BaselineInputs;
  ivShift?: number; // §5.7 when greeks available
}

export interface SnapshotResult extends MomentumSnapshot {
  liquidityOk: boolean;
  spreadPct?: number;
  /** extras consumed by the §14 lifecycle engine */
  premium: number;
  fastWindowVol: number;
  atr: number;
}

export function computeSnapshot(
  input: SnapshotInput,
  cfg: SnapshotConfig,
): SnapshotResult {
  const { bars, underlyingBars } = input;
  const vel = velocity(bars, cfg.windows.fast, input.baseline.retVol, cfg.retVolFloor);
  const velSlow = velocity(bars, cfg.windows.slow, input.baseline.retVol, cfg.retVolFloor);
  const acc = acceleration(bars, cfg.windows.fast, input.baseline.retVol, cfg.retVolFloor);
  const burst = volumeBurst(
    bars,
    cfg.windows.fast,
    input.baseline,
    cfg.volumeBurstZCap,
    cfg.volStdFloor,
  );
  const flow = flowImbalance(bars, cfg.windows.fast * 2);
  const oi = oiDeltaRate(bars, cfg.windows.oi);

  const lastBar = bars[bars.length - 1];
  const spreadPct = lastBar?.spreadPct;
  const uVel = velocity(
    underlyingBars,
    cfg.windows.fast,
    input.underlyingBaseline.retVol,
    cfg.retVolFloor,
  );
  const direction: Direction = vel.normalized >= 0 ? 1 : -1;
  const confirmation = underlyingConfirmation(
    direction,
    input.side,
    uVel.available ? uVel.normalized : 0,
    cfg.confirmationMin,
    cfg.confirmationMax,
  );
  const penalty = spreadPenalty(spreadPct, cfg.maxSpreadPct);

  const comp = composite({
    components: [vel, acc, burst, flow],
    weights: cfg.weights,
    underlyingConfirmation: confirmation,
    spreadPenalty: penalty,
  });

  const fastVol = bars
    .slice(-cfg.windows.fast)
    .reduce((a, b) => a + b.vol, 0);
  const spreadOk = spreadPct === undefined || spreadPct <= cfg.maxSpreadPct;
  const liquidityOk = fastVol >= cfg.minWindowVol && spreadOk && !lastBar?.gap;

  const classification = classify({
    priceDirection: comp.direction,
    oiDelta: oi.raw,
    score: comp.score,
    noiseFloor: cfg.noiseFloor,
    ivShift: input.ivShift,
    underlyingVelocityNorm: uVel.available ? uVel.normalized : undefined,
  });

  const components: ComponentEvidence[] = [
    vel,
    { ...velSlow, name: "velocitySlow" },
    acc,
    burst,
    flow,
    oi,
    { name: "underlyingVelocity", raw: uVel.raw, normalized: uVel.normalized, available: uVel.available },
  ].map((c) => ({
    name: c.name,
    raw: c.raw,
    normalized: c.normalized,
    available: c.available,
  }));

  return {
    instrumentKey: input.instrumentKey,
    ts: input.ts,
    score: comp.score,
    direction: comp.direction,
    classification,
    components,
    underlyingConfirmation: confirmation,
    liquidityOk,
    spreadPct,
    premium: lastBar?.c ?? 0,
    fastWindowVol: fastVol,
    atr: atr(bars, 30),
  };
}
