import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Episode, MomentumEvent, SnapshotResult } from "@momentum-scan/shared";
import {
  EpisodeMachine,
  EpisodeState,
  type EpisodeStepInput,
  type LifecycleStepConfig,
} from "@momentum-scan/shared";
import { lifecycleSummary } from "../alerts/templates";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";
import { SignalBus } from "../signals/signal-bus";

/**
 * Live lifecycle engine (SPEC §14): opens an Episode when a MomentumEvent
 * fires, steps it once per momentum snapshot (1s cadence), and emits
 * MomentumFading / MomentumReignited / MomentumDead transitions with
 * template-rendered descriptive summaries. One active episode per
 * instrument; closed episodes free the slot after the §5 cooldown.
 */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap {
  private readonly log = createLogger("lifecycle");
  private readonly machines = new Map<string, EpisodeMachine>();
  private readonly lastSnapshot = new Map<string, SnapshotResult>();
  private readonly cfg: LifecycleStepConfig;
  transitionsEmitted = 0;

  constructor(
    @Inject(AppConfigService) config: AppConfigService,
    @Inject(SignalBus) private readonly bus: SignalBus,
  ) {
    const lc = config.momentum.lifecycle;
    this.cfg = {
      decayWeights: lc.decayWeights,
      accelReversalStepsFull: lc.accelReversalStepsFull,
      volumeFadeFloorRatio: lc.volumeFadeFloorRatio,
      stallBudgetSteps: lc.stallBudgetSec, // 1 step = 1s live
      pullbackAtrK: lc.pullbackAtrK,
      flowFlipStepsFull: lc.flowFlipStepsFull,
      peakConfirmSteps: lc.peakConfirmSteps,
      fadingAt: lc.fadingAt,
      reigniteBelow: lc.reigniteBelow,
      deadAt: lc.deadAt,
      deadScoreFloor: lc.deadScoreFloor,
      maxEpisodeSteps: lc.maxEpisodeSec,
    };
  }

  onApplicationBootstrap(): void {
    this.bus.onEvent((e) => this.onEvent(e));
    this.bus.onSnapshot((s) => this.onSnapshot(s));
  }

  activeEpisodes(): Episode[] {
    return [...this.machines.values()].map((m) => m.episode);
  }

  episodeFor(key: string): Episode | undefined {
    return this.machines.get(key)?.episode;
  }

  private onEvent(e: MomentumEvent): void {
    if (this.machines.has(e.instrumentKey)) return; // episode already running
    const snap = this.lastSnapshot.get(e.instrumentKey);
    const vel = e.components.find((c) => c.name === "velocity");
    this.machines.set(
      e.instrumentKey,
      new EpisodeMachine(this.cfg, {
        id: e.episodeId,
        instrumentKey: e.instrumentKey,
        direction: e.direction,
        openedAt: e.ts,
        score: e.score,
        premium: snap?.premium ?? 0,
        windowVol: snap?.fastWindowVol ?? 1,
        velocity: vel?.normalized ?? 0,
      }),
    );
    this.log.info({ key: e.instrumentKey, episode: e.episodeId }, "episode opened");
  }

  private onSnapshot(s: SnapshotResult): void {
    this.lastSnapshot.set(s.instrumentKey, s);
    const machine = this.machines.get(s.instrumentKey);
    if (!machine) return;

    const accel = s.components.find((c) => c.name === "acceleration");
    const flow = s.components.find((c) => c.name === "flowImbalance");
    const input: EpisodeStepInput = {
      ts: s.ts,
      score: s.score,
      premium: s.premium,
      windowVol: s.fastWindowVol,
      acceleration: accel?.available ? accel.normalized : 0,
      flowImbalance: flow?.available ? flow.normalized : undefined,
      underlyingConfirmation: s.underlyingConfirmation,
      atr: s.atr,
    };
    const { episode, transitions } = machine.step(input);
    for (const t of transitions) {
      t.summary = lifecycleSummary(t.type, t.episode, t.ts);
      this.transitionsEmitted += 1;
      this.log.info(
        { key: s.instrumentKey, type: t.type, decay: Math.round(episode.decayScore) },
        t.summary,
      );
      this.bus.emitLifecycle(t);
    }
    if (episode.state === EpisodeState.DEAD) {
      this.machines.delete(s.instrumentKey);
    }
  }
}
