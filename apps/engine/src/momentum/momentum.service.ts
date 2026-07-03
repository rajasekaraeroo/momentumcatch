import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Bar, MomentumEvent, MomentumSnapshot } from "@momentum-scan/shared";
import {
  computeSnapshot,
  EmissionGate,
  type BaselineInputs,
  type SnapshotConfig,
} from "@momentum-scan/shared";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";
import { SignalBus } from "../signals/signal-bus";
import { InstrumentRegistry } from "../universe/instrument-registry";
import type { BaselineSnapshot } from "./baselines";

/**
 * Live momentum engine (SPEC §5): consumes closed 1s bars from the
 * aggregation layer, maintains in-memory trailing windows, and computes the
 * composite score + evidence via the SHARED math (packages/shared) — the
 * same functions the backtester re-windows to 1 minute. Emits snapshots and
 * threshold-crossing MomentumEvents on the SignalBus.
 */
@Injectable()
export class MomentumService {
  private readonly log = createLogger("momentum");
  private readonly windows = new Map<string, Bar[]>();
  private readonly baselines = new Map<string, BaselineSnapshot>();
  private readonly gates = new Map<string, EmissionGate>();
  private readonly latest = new Map<string, MomentumSnapshot>();
  private readonly cfg: SnapshotConfig;
  eventsEmitted = 0;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(InstrumentRegistry) private readonly registry: InstrumentRegistry,
    @Inject(SignalBus) private readonly bus: SignalBus,
  ) {
    const m = config.momentum;
    this.cfg = {
      windows: { fast: m.windows.fastSec, slow: m.windows.slowSec, oi: m.windows.oiSec },
      weights: m.weights,
      volumeBurstZCap: m.caps.volumeBurstZ,
      confirmationMin: m.underlyingConfirmation.min,
      confirmationMax: m.underlyingConfirmation.max,
      maxSpreadPct: m.liquidityGate.maxSpreadPct,
      minWindowVol: m.liquidityGate.minVol5s,
      noiseFloor: m.emission.rearmBelow,
      retVolFloor: m.floors.retVol,
      volStdFloor: m.floors.volStd,
    };
  }

  /** Wired from AggregationService after each batch of closed bars. */
  onBars(instrumentKey: string, bars: Bar[], baseline: BaselineSnapshot): void {
    if (bars.length === 0) return;
    const win = this.windows.get(instrumentKey) ?? [];
    win.push(...bars);
    const cap = this.config.momentum.windows.baselineSec + this.cfg.windows.slow + 1;
    if (win.length > cap) win.splice(0, win.length - cap);
    this.windows.set(instrumentKey, win);
    this.baselines.set(instrumentKey, baseline);

    const meta = this.registry.get(instrumentKey);
    if (meta?.kind !== "option") return; // scores are computed per option
    this.evaluate(instrumentKey, meta.side, meta.underlyingKey);
  }

  latestSnapshot(key: string): MomentumSnapshot | undefined {
    return this.latest.get(key);
  }

  allSnapshots(): MomentumSnapshot[] {
    return [...this.latest.values()];
  }

  private toBaselineInputs(b: BaselineSnapshot | undefined): BaselineInputs {
    return {
      volMean: b?.volMean ?? 0,
      volStd: b?.volStd ?? 0,
      retVol: b?.absRetStd ?? 0,
      samples: b?.samples ?? 0,
    };
  }

  private evaluate(key: string, side: 1 | -1, underlyingKey: string): void {
    const bars = this.windows.get(key) ?? [];
    const lastBar = bars[bars.length - 1];
    if (!lastBar) return;
    const underlyingBars = this.windows.get(underlyingKey) ?? [];

    // §5.7 IV shift over the OI window, when greeks are present
    const withIv = bars.slice(-this.cfg.windows.oi).filter((b) => b.iv !== undefined);
    const first = withIv[0];
    const lastIv = withIv[withIv.length - 1];
    const ivShift =
      withIv.length >= 2 && first && lastIv
        ? (lastIv.iv as number) - (first.iv as number)
        : undefined;

    const snapshot = computeSnapshot(
      {
        instrumentKey: key,
        ts: lastBar.ts,
        side,
        bars,
        underlyingBars,
        baseline: this.toBaselineInputs(this.baselines.get(key)),
        underlyingBaseline: this.toBaselineInputs(this.baselines.get(underlyingKey)),
        ivShift,
      },
      this.cfg,
    );

    this.latest.set(key, snapshot);
    this.bus.emitSnapshot(snapshot);

    let gate = this.gates.get(key);
    if (!gate) {
      gate = new EmissionGate({
        threshold: this.config.momentum.emission.scoreThreshold,
        rearmBelow: this.config.momentum.emission.rearmBelow,
        cooldownSteps: this.config.momentum.emission.cooldownSec,
      });
      this.gates.set(key, gate);
    }
    const verdict = gate.update(
      snapshot.score,
      snapshot.liquidityOk,
      Math.floor(lastBar.ts / 1000),
    );
    if (verdict !== "emit") return;

    const id = randomUUID();
    const event: MomentumEvent = { ...snapshot, id, episodeId: id };
    this.eventsEmitted += 1;
    this.log.info(
      {
        key,
        score: Math.round(snapshot.score * 10) / 10,
        direction: snapshot.direction,
        classification: snapshot.classification,
      },
      "momentum event observed",
    );
    this.bus.emitEvent(event);
  }
}
