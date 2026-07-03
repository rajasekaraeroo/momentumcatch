import type { DecayEvidence, Direction, Episode, LifecycleTransition } from "../types";
import { EpisodeState, LifecycleEventType } from "../types";
import { clamp } from "../indicators/momentum-core";

/**
 * Momentum lifecycle & decay engine (SPEC §14): an episode state machine
 * that runs IDENTICALLY in live (1s steps) and backtest (1m steps) — only
 * the step-unit config differs. Pure: callers feed one EpisodeStepInput per
 * step; the machine returns transitions to emit. No clocks, no I/O.
 */

export interface LifecycleStepConfig {
  decayWeights: {
    accelerationReversal: number;
    volumeFade: number;
    extremeStall: number;
    pullbackDepth: number;
    flowFlip: number;
    underlyingDivergence: number;
  };
  /** consecutive opposite-acceleration steps for full §14.2.1 score */
  accelReversalStepsFull: number;
  /** §14.2.2: fade is 1.0 at vol ratio ≤ this, 0 at ≥ 1.0 */
  volumeFadeFloorRatio: number;
  /** §14.2.3 stall budget, in steps */
  stallBudgetSteps: number;
  /** §14.2.4 pullback measured against k × ATR */
  pullbackAtrK: number;
  /** §14.2.5 opposite-flow steps for full flow-flip score */
  flowFlipStepsFull: number;
  /** §14.3 BUILDING→PEAK: no new score high for this many steps, score ≥ 50 */
  peakConfirmSteps: number;
  fadingAt: number; // decayScore crossing up (50)
  reigniteBelow: number; // decay hysteresis (30)
  deadAt: number; // decayScore (75)
  deadScoreFloor: number; // composite score (35)
  maxEpisodeSteps: number; // hard timeout (900 live / re-mapped backtest)
}

export interface EpisodeStepInput {
  ts: number;
  /** composite §5 score */
  score: number;
  /** option premium (close of the step) */
  premium: number;
  /** fast-window traded volume — same metric as ignition.windowVol */
  windowVol: number;
  /** signed normalized acceleration (§5.2) */
  acceleration: number;
  /** signed flow imbalance EMA; undefined in backtest (§14.2.5) */
  flowImbalance?: number;
  /** §5.6 multiplier */
  underlyingConfirmation: number;
  /** trailing ATR of the premium (30 steps) */
  atr: number;
}

export interface StepOutcome {
  episode: Episode;
  transitions: LifecycleTransition[];
}

export class EpisodeMachine {
  private readonly ep: Episode;
  private steps = 0;
  private oppositeAccelStreak = 0;
  private oppositeFlowStreak = 0;
  private stepsSinceScoreHigh = 0;
  private stepsSinceExtreme = 0;
  private premiumAtFading: number | null = null;
  private prevDecay = 0;

  constructor(
    private readonly cfg: LifecycleStepConfig,
    init: {
      id: string;
      instrumentKey: string;
      direction: Direction;
      openedAt: number;
      score: number;
      premium: number;
      windowVol: number;
      velocity: number;
    },
  ) {
    this.ep = {
      id: init.id,
      instrumentKey: init.instrumentKey,
      direction: init.direction,
      openedAt: init.openedAt,
      state: EpisodeState.BUILDING,
      ignition: {
        score: init.score,
        windowVol: Math.max(init.windowVol, 1),
        velocity: init.velocity,
        premium: init.premium,
      },
      peak: { score: init.score, premiumExtreme: init.premium, ts: init.openedAt },
      decayScore: 0,
      decayEvidence: {
        accelerationReversal: 0,
        volumeFade: 0,
        extremeStall: 0,
        pullbackDepth: 0,
        underlyingDivergence: 0,
      },
    };
  }

  get episode(): Episode {
    return this.ep;
  }

  step(input: EpisodeStepInput): StepOutcome {
    const ep = this.ep;
    const dir = ep.direction;
    this.steps += 1;
    const transitions: LifecycleTransition[] = [];

    // running peak tracking (§14.1)
    if (input.score > ep.peak.score) {
      ep.peak.score = input.score;
      this.stepsSinceScoreHigh = 0;
    } else {
      this.stepsSinceScoreHigh += 1;
    }
    const newExtreme = dir * (input.premium - ep.peak.premiumExtreme) > 0;
    if (newExtreme) {
      ep.peak.premiumExtreme = input.premium;
      ep.peak.ts = input.ts;
      this.stepsSinceExtreme = 0;
    } else {
      this.stepsSinceExtreme += 1;
    }

    // §14.2 decay components, each in [0,1]
    this.oppositeAccelStreak =
      Math.sign(input.acceleration) === -dir && input.acceleration !== 0
        ? this.oppositeAccelStreak + 1
        : 0;
    const cAccel = clamp(this.oppositeAccelStreak / this.cfg.accelReversalStepsFull, 0, 1);

    const volRatio = input.windowVol / ep.ignition.windowVol;
    const floor = this.cfg.volumeFadeFloorRatio;
    const cVol = clamp((1 - volRatio) / (1 - floor), 0, 1);

    const cStall = clamp(this.stepsSinceExtreme / this.cfg.stallBudgetSteps, 0, 1);

    const retrace = dir * (ep.peak.premiumExtreme - input.premium);
    const cPull =
      input.atr > 0 ? clamp(retrace / (this.cfg.pullbackAtrK * input.atr), 0, 1) : 0;

    let cFlow: number | undefined;
    if (input.flowImbalance !== undefined) {
      this.oppositeFlowStreak =
        Math.sign(input.flowImbalance) === -dir && input.flowImbalance !== 0
          ? this.oppositeFlowStreak + 1
          : 0;
      cFlow = clamp(this.oppositeFlowStreak / this.cfg.flowFlipStepsFull, 0, 1);
    }

    const cDiv = clamp((1 - input.underlyingConfirmation) / 0.5, 0, 1);

    const w = this.cfg.decayWeights;
    const parts: [number, number][] = [
      [w.accelerationReversal, cAccel],
      [w.volumeFade, cVol],
      [w.extremeStall, cStall],
      [w.pullbackDepth, cPull],
      [w.underlyingDivergence, cDiv],
    ];
    if (cFlow !== undefined) parts.push([w.flowFlip, cFlow]);
    // renormalize over available components (§14.2)
    const totalW = parts.reduce((a, [wi]) => a + wi, 0);
    const decay = totalW > 0 ? (100 * parts.reduce((a, [wi, ci]) => a + wi * ci, 0)) / totalW : 0;

    ep.decayScore = decay;
    const evidence: DecayEvidence = {
      accelerationReversal: cAccel,
      volumeFade: cVol,
      extremeStall: cStall,
      pullbackDepth: cPull,
      underlyingDivergence: cDiv,
      ...(cFlow !== undefined ? { flowFlip: cFlow } : {}),
    };
    ep.decayEvidence = evidence;

    // §14.3 transitions
    const timeout = this.steps > this.cfg.maxEpisodeSteps;
    switch (ep.state) {
      case EpisodeState.BUILDING: {
        if (timeout || input.score < this.cfg.deadScoreFloor) {
          transitions.push(this.die(input));
          break;
        }
        if (
          this.stepsSinceScoreHigh >= this.cfg.peakConfirmSteps &&
          input.score >= 50
        ) {
          ep.state = EpisodeState.PEAK;
        }
        break;
      }
      case EpisodeState.PEAK: {
        if (timeout) {
          transitions.push(this.die(input));
          break;
        }
        if (decay >= this.cfg.fadingAt && this.prevDecay < this.cfg.fadingAt) {
          ep.state = EpisodeState.FADING;
          this.premiumAtFading = input.premium;
          transitions.push(this.transition(LifecycleEventType.MOMENTUM_FADING, input.ts));
        }
        break;
      }
      case EpisodeState.FADING: {
        if (
          decay >= this.cfg.deadAt ||
          input.score < this.cfg.deadScoreFloor ||
          timeout
        ) {
          transitions.push(this.die(input));
          break;
        }
        // hysteresis re-ignition: decay collapsed AND a new episode score high
        if (decay < this.cfg.reigniteBelow && input.score >= ep.peak.score) {
          ep.state = EpisodeState.PEAK;
          this.premiumAtFading = null;
          transitions.push(
            this.transition(LifecycleEventType.MOMENTUM_REIGNITED, input.ts),
          );
        }
        break;
      }
      case EpisodeState.DEAD:
        break;
    }

    this.prevDecay = decay;
    return { episode: ep, transitions };
  }

  /** giveback: fraction of the favorable move surrendered by `premium` */
  private givebackAt(premium: number): number {
    const ep = this.ep;
    const favorable = ep.direction * (ep.peak.premiumExtreme - ep.ignition.premium);
    if (favorable <= 0) return 1;
    return clamp((ep.direction * (ep.peak.premiumExtreme - premium)) / favorable, 0, 1);
  }

  /** giveback measured at the FADING signal (§13.4.5 decay capture) */
  fadingGiveback(): number | null {
    return this.premiumAtFading === null ? null : this.givebackAt(this.premiumAtFading);
  }

  private die(input: EpisodeStepInput): LifecycleTransition {
    const ep = this.ep;
    ep.state = EpisodeState.DEAD;
    ep.closedAt = input.ts;
    ep.givebackPct = this.givebackAt(input.premium);
    return this.transition(LifecycleEventType.MOMENTUM_DEAD, input.ts);
  }

  private transition(type: LifecycleEventType, ts: number): LifecycleTransition {
    // summary text is rendered by the caller from alerts/templates.ts —
    // the machine stays copy-free so the compliance audit has one surface
    return { type, episode: { ...this.ep }, ts, summary: "" };
  }
}
