import { randomUUID } from "node:crypto";
import type { Bar, Episode, MomentumEvent } from "@momentum-scan/shared";
import {
  computeSnapshot,
  EmissionGate,
  EpisodeMachine,
  EpisodeState,
  type LifecycleStepConfig,
  type LifecycleTransition,
  type SnapshotConfig,
  type SnapshotResult,
} from "@momentum-scan/shared";
import { Baselines } from "../momentum/baselines";
import type { BacktestConfig } from "./config";

/**
 * The 1-minute backtest engine (SPEC §13.2–§13.3): the SAME shared momentum
 * + lifecycle code paths as the live engine, re-windowed to candles. STRICT
 * no-lookahead by construction — `step(ts, candles)` is the only input, and
 * all state derives from candles already fed. Verified by the
 * poisoned-future fixture test.
 *
 * Track-A exclusions (§13.0): flow imbalance and spread penalty are absent
 * at this resolution; weights come renormalized from config/backtest.yaml
 * and the liquidity gate is the static min-candle-volume.
 */

export interface BtInstrument {
  key: string;
  side: 1 | -1;
  underlyingKey: string;
  strike?: number;
  expiry?: string;
}

export interface ClosedEpisode {
  episode: Episode;
  fadingGiveback: number | null;
  /** giveback measured at the naive score<40 rule (§14.5 comparison) */
  naiveGiveback: number | null;
}

export interface BacktestHooks {
  onEvent?: (event: MomentumEvent, snapshot: SnapshotResult) => void;
  onTransition?: (t: LifecycleTransition) => void;
  onEpisodeClosed?: (closed: ClosedEpisode) => void;
  /** every evaluated option-minute (post-warmup), causal — for descriptive
   *  analysis passes that need the score at all minutes, not only emissions. */
  onSnapshot?: (snapshot: SnapshotResult, meta: BtInstrument) => void;
}

const NAIVE_DECAY_SCORE = 40; // §5's simple rule, kept for the §14.5 report

interface InstrumentState {
  window: Bar[];
  baselines: Baselines;
  candlesSeen: number;
  gate: EmissionGate;
  machine: EpisodeMachine | null;
  naivePremium: number | null; // premium at first score<40 after the event
  eventScoreSeen: boolean;
}

export class BacktestEngine {
  private readonly snapshotCfg: SnapshotConfig;
  private readonly lifecycleCfg: LifecycleStepConfig;
  private readonly state = new Map<string, InstrumentState>();

  constructor(
    private readonly cfg: BacktestConfig,
    momentumLifecycle: {
      decayWeights: LifecycleStepConfig["decayWeights"];
      volumeFadeFloorRatio: number;
      pullbackAtrK: number;
      fadingAt: number;
      reigniteBelow: number;
      deadAt: number;
      deadScoreFloor: number;
      maxEpisodeSteps: number;
    },
    private readonly instruments: Map<string, BtInstrument>,
    private readonly hooks: BacktestHooks,
    private readonly scoreThresholdOverride?: number,
  ) {
    this.snapshotCfg = {
      windows: {
        fast: cfg.windows.fastCandles,
        slow: cfg.windows.slowCandles,
        oi: cfg.windows.oiCandles,
      },
      weights: { ...cfg.weights, flowImbalance: 0 }, // EXCLUDED at 1m (§13.2)
      volumeBurstZCap: 6,
      confirmationMin: 0.5,
      confirmationMax: 1.5,
      maxSpreadPct: Number.POSITIVE_INFINITY, // spread EXCLUDED at 1m (§13.2)
      minWindowVol: cfg.liquidityGate.minCandleVolume,
      noiseFloor: cfg.emission.rearmBelow,
      retVolFloor: 0.0005,
      volStdFloor: 1,
    };
    this.lifecycleCfg = {
      decayWeights: momentumLifecycle.decayWeights,
      accelReversalStepsFull: cfg.lifecycle.accelReversalCandlesFull,
      volumeFadeFloorRatio: momentumLifecycle.volumeFadeFloorRatio,
      stallBudgetSteps: cfg.lifecycle.stallBudgetCandles,
      pullbackAtrK: momentumLifecycle.pullbackAtrK,
      flowFlipStepsFull: 1, // weight renormalized away (no flow at 1m)
      peakConfirmSteps: cfg.lifecycle.peakConfirmCandles,
      fadingAt: momentumLifecycle.fadingAt,
      reigniteBelow: momentumLifecycle.reigniteBelow,
      deadAt: momentumLifecycle.deadAt,
      deadScoreFloor: momentumLifecycle.deadScoreFloor,
      maxEpisodeSteps: Math.ceil(momentumLifecycle.maxEpisodeSteps / 60),
    };
  }

  /** reset per-session state (SPEC §13.3 — baselines never span sessions) */
  newSession(): void {
    this.state.clear();
  }

  private stateFor(key: string): InstrumentState {
    let s = this.state.get(key);
    if (!s) {
      s = {
        window: [],
        baselines: new Baselines(this.cfg.windows.baselineCandles, 300),
        candlesSeen: 0,
        gate: new EmissionGate({
          threshold: this.scoreThresholdOverride ?? this.cfg.emission.scoreThreshold,
          rearmBelow: this.cfg.emission.rearmBelow,
          cooldownSteps: this.cfg.emission.cooldownCandles,
        }),
        machine: null,
        naivePremium: null,
        eventScoreSeen: false,
      };
      this.state.set(key, s);
    }
    return s;
  }

  /**
   * Feed ONE minute of the session: every candle whose timestamp is `ts`.
   * Index candles are applied before options so §5.6 confirmation for
   * minute t can see the underlying's candle at t (still ≤ t — no future).
   */
  step(ts: number, candles: Bar[]): void {
    const index = candles.filter((c) => !this.instruments.has(c.instrumentKey));
    const options = candles.filter((c) => this.instruments.has(c.instrumentKey));
    for (const c of [...index, ...options]) {
      const s = this.stateFor(c.instrumentKey);
      s.window.push(c);
      const cap = this.cfg.windows.baselineCandles + this.cfg.windows.slowCandles + 1;
      if (s.window.length > cap) s.window.splice(0, s.window.length - cap);
      s.baselines.update(c);
      s.candlesSeen += 1;
    }
    for (const c of options) this.evaluate(c.instrumentKey, ts);
  }

  private evaluate(key: string, ts: number): void {
    const meta = this.instruments.get(key) as BtInstrument;
    const s = this.stateFor(key);
    if (s.candlesSeen < this.cfg.windows.warmupCandles && !s.machine) return; // §13.3 warm-up

    const u = this.stateFor(meta.underlyingKey);
    const bl = s.baselines.snapshot();
    const ubl = u.baselines.snapshot();
    const snapshot = computeSnapshot(
      {
        instrumentKey: key,
        ts,
        side: meta.side,
        bars: s.window,
        underlyingBars: u.window,
        baseline: {
          volMean: bl.volMean,
          volStd: bl.volStd,
          retVol: bl.absRetStd,
          samples: bl.samples,
        },
        underlyingBaseline: {
          volMean: ubl.volMean,
          volStd: ubl.volStd,
          retVol: ubl.absRetStd,
          samples: ubl.samples,
        },
      },
      this.snapshotCfg,
    );

    // descriptive observation hook (causal — snapshot uses candles ≤ ts only)
    this.hooks.onSnapshot?.(snapshot, meta);

    // lifecycle first: an existing episode steps on every candle
    if (s.machine) {
      const accel = snapshot.components.find((c) => c.name === "acceleration");
      const { episode, transitions } = s.machine.step({
        ts,
        score: snapshot.score,
        premium: snapshot.premium,
        windowVol: snapshot.fastWindowVol,
        acceleration: accel?.available ? accel.normalized : 0,
        flowImbalance: undefined, // EXCLUDED at 1m — weight renormalizes (§14.2.5)
        underlyingConfirmation: snapshot.underlyingConfirmation,
        atr: snapshot.atr,
      });
      // naive §5 rule tracking for the §14.5 report comparison
      if (s.eventScoreSeen && s.naivePremium === null && snapshot.score < NAIVE_DECAY_SCORE) {
        s.naivePremium = snapshot.premium;
      }
      for (const t of transitions) this.hooks.onTransition?.(t);
      if (episode.state === EpisodeState.DEAD) {
        const dir = episode.direction;
        const favorable = dir * (episode.peak.premiumExtreme - episode.ignition.premium);
        const naiveGiveback =
          s.naivePremium !== null && favorable > 0
            ? Math.max(0, Math.min(1, (dir * (episode.peak.premiumExtreme - s.naivePremium)) / favorable))
            : null;
        this.hooks.onEpisodeClosed?.({
          episode,
          fadingGiveback: s.machine.fadingGiveback(),
          naiveGiveback,
        });
        s.machine = null;
        s.naivePremium = null;
        s.eventScoreSeen = false;
      }
      return; // one episode at a time per instrument (§14)
    }

    const verdict = s.gate.update(
      snapshot.score,
      snapshot.liquidityOk,
      Math.floor(ts / 60_000),
    );
    if (verdict !== "emit") return;
    const id = randomUUID();
    const vel = snapshot.components.find((c) => c.name === "velocity");
    s.machine = new EpisodeMachine(this.lifecycleCfg, {
      id,
      instrumentKey: key,
      direction: snapshot.direction,
      openedAt: ts,
      score: snapshot.score,
      premium: snapshot.premium,
      windowVol: snapshot.fastWindowVol,
      velocity: vel?.normalized ?? 0,
    });
    s.eventScoreSeen = true;
    this.hooks.onEvent?.({ ...snapshot, id, episodeId: id }, snapshot);
  }
}
