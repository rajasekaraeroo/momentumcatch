import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import path from "node:path";
import type { Tick } from "@momentum-scan/shared";
import { AuthService } from "../auth/auth.service";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";
import { FeedState } from "./feed-state";
import { isWithinFeedWindow } from "./market-hours";
import { FeedMetrics } from "./metrics";
import { loadFeedDecoder, type FeedDecoder } from "./proto";
import { FocusPoolService } from "../focus-pool/focus-pool.service";
import { SignalBus } from "../signals/signal-bus";
import { TICK_STREAM, type TickStreamBus } from "../streams/tick-stream";
import { ConnectionManager } from "./connection-manager";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { UniverseService } from "../universe/universe.service";
import { TickRecorder } from "./tick-recorder";
import { UpstoxFeedSource } from "./upstox-feed.source";

const SCHEDULER_INTERVAL_MS = 15_000;

export interface FeedStatus {
  state: FeedState;
  subscriptionCount: number;
  protoAvailable: boolean;
  metrics: Record<string, number | null>;
  /** §12.8: per-connection states ("A" broad D5, "B" focus pool D30) */
  connections: Record<string, string>;
}

/**
 * Feed orchestrator: market-hours scheduling (SPEC §2), token polling
 * (§12.2 — auto-start the moment a token appears), tick fan-out to the
 * Redis stream (§1) with gap markers on reconnect recovery (§9), and
 * optional NDJSON recording (§6).
 *
 * Subscribes to the underlying index keys from config/universe.yaml;
 * option-universe resolution from the instruments master (§12.3) arrives
 * with subscription management in Stage 3. FEED_KEYS overrides for testing.
 */
@Injectable()
export class FeedService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = createLogger("feed");
  private readonly tickLog = createLogger("tick");
  readonly metrics = new FeedMetrics();

  private state: FeedState = FeedState.AWAITING_AUTH;
  private source: UpstoxFeedSource | null = null;
  private sourceB: UpstoxFeedSource | null = null;
  private readonly manager = new ConnectionManager();
  private decoder: FeedDecoder | null = null;
  private protoError: string | null = null;
  private recorder: TickRecorder | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private readonly instrumentKeys: string[];

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TICK_STREAM) private readonly bus: TickStreamBus,
    @Inject(UniverseService) private readonly universe: UniverseService,
    @Inject(InstrumentRegistry) private readonly registry: InstrumentRegistry,
    @Inject(SignalBus) private readonly signals: SignalBus,
    @Inject(FocusPoolService) private readonly focusPool: FocusPoolService,
  ) {
    this.instrumentKeys = config.env.FEED_KEYS
      ? config.env.FEED_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
      : config.universe.underlyings.map((u) => u.indexInstrumentKey);
    if (config.env.RECORD_TICKS) {
      this.recorder = new TickRecorder(
        path.join(config.repoRoot, "data", "ticks"),
      );
    }
    // intraday universe changes (§2 re-centering) go out as sub/unsub diffs
    this.universe.onSubscriptionDiff = (add, remove) =>
      this.source?.updateSubscriptions(add, remove);
    // §12.8 focus-pool promotions/demotions go to Connection B
    this.focusPool.onDiff = (add, remove) =>
      this.manager.updateSubscriptions("B", add, remove);
  }

  /** index keys from config plus the currently resolved option universe */
  private currentKeys(): string[] {
    return [...new Set([...this.instrumentKeys, ...this.universe.optionKeys()])];
  }

  onApplicationBootstrap(): void {
    this.log.info(
      { keys: this.instrumentKeys, count: this.instrumentKeys.length },
      "feed scheduler started (subscription count logged per SPEC §12.4)",
    );
    this.schedulerTimer = setInterval(() => void this.reconcile(), SCHEDULER_INTERVAL_MS);
    void this.reconcile();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    await this.manager.stopAll();
    this.recorder?.close();
  }

  getStatus(): FeedStatus {
    return {
      state: this.state,
      subscriptionCount: this.currentKeys().length,
      protoAvailable: this.decoder !== null,
      metrics: this.metrics.snapshot(Date.now()),
      connections: this.manager.states(),
    };
  }

  /** Decide whether the feed should be up, and converge to that. */
  private async reconcile(): Promise<void> {
    const withinWindow =
      this.config.env.FEED_IGNORE_MARKET_HOURS ||
      isWithinFeedWindow(Date.now(), {
        connectIst: this.config.universe.schedule.connectIst,
        disconnectIst: this.config.universe.schedule.disconnectIst,
        holidays: this.config.holidays,
      });

    if (!withinWindow) {
      if (this.source) {
        this.log.info("outside market-hours window — disconnecting feed");
        await this.manager.stopAll();
        this.source = null;
        this.sourceB = null;
      }
      this.setState(FeedState.IDLE_CLOSED);
      return;
    }

    if (this.source) return; // already running; source manages its own health

    const token = await this.auth.getToken();
    if (!token) {
      this.setState(FeedState.AWAITING_AUTH);
      return;
    }

    if (!this.decoder) {
      try {
        this.decoder = await loadFeedDecoder(this.config.repoRoot);
        this.protoError = null;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== this.protoError) {
          this.log.error(msg);
          this.protoError = msg;
        }
        this.setState(FeedState.STOPPED);
        return;
      }
    }

    this.source = new UpstoxFeedSource({
      name: "A",
      mode: "full",
      decoder: this.decoder,
      tokenProvider: () => this.auth.getToken(),
      instrumentKeys: () => this.currentKeys(),
      onTick: (tick) => this.handleTick(tick, "A"),
      onState: (s) => this.setState(s),
      metrics: this.metrics,
      log: this.log.child({ conn: "A" }),
    });
    this.manager.add("A", this.source, FeedState.CONNECTING);
    await this.source.start();

    // §12.8 Connection B — the full_d30 focus pool (Upstox Plus). Failures
    // here degrade to D5-only; they never take down Connection A.
    if (this.focusPool.enabled && !this.sourceB) {
      this.sourceB = new UpstoxFeedSource({
        name: "B",
        mode: "full_d30",
        decoder: this.decoder,
        tokenProvider: () => this.auth.getToken(),
        instrumentKeys: () => this.focusPool.state().slots,
        onTick: (tick) => this.handleTick(tick, "B"),
        onState: (s) => {
          this.manager.setState("B", s);
          this.focusPool.setConnectionState(s);
          this.signals.emitFeedState(s, { connection: "B" });
        },
        metrics: this.metrics,
        log: this.log.child({ conn: "B" }),
      });
      this.manager.add("B", this.sourceB, FeedState.CONNECTING);
      await this.sourceB.start();
    }
  }

  private handleTick(tick: Tick, connection: string = "A"): void {
    // §12.8: while pooled AND Connection B is live, B is the single source
    // of truth for that instrument — drop A's duplicate D5 ticks. If B is
    // down, A's ticks flow again (graceful D5 degradation).
    if (
      connection === "A" &&
      this.focusPool.enabled &&
      this.focusPool.isPooled(tick.instrumentKey) &&
      this.manager.stateOf("B") === FeedState.LIVE
    ) {
      return;
    }
    // index prints drive universe resolution + re-centering (SPEC §2, §12.3)
    if (this.registry.get(tick.instrumentKey)?.kind === "index") {
      void this.universe.onIndexTick(tick.instrumentKey, tick.ltp, Date.now());
    }
    this.tickLog.debug(
      { key: tick.instrumentKey, ts: tick.ts, ltp: tick.ltp, vol: tick.volume },
      "tick",
    );
    // Fan out to the Redis stream (SPEC §1) — feed and momentum stay
    // decoupled so they can be split into separate processes later.
    this.bus.publishTick(tick).catch((err: Error) => {
      this.metrics.streamPublishErrors += 1;
      if (this.metrics.streamPublishErrors === 1) {
        this.log.error({ err: err.message }, "tick stream publish failed");
      }
    });
    this.recorder?.record(tick);
  }

  private setState(state: FeedState): void {
    if (state === this.state) return;
    this.manager.setState("A", state);
    this.log.info({ from: this.state, to: state }, "feed state change");
    this.signals.emitFeedState(state, { from: this.state, connection: "A" });
    const recovering =
      state === FeedState.LIVE &&
      (this.state === FeedState.RECONNECTING ||
        this.state === FeedState.TICK_STARVED);
    this.state = state;
    if (recovering) {
      // Ticks were lost during the outage — tell consumers to restart
      // baselines rather than z-score across the gap (SPEC §9).
      this.bus.publishGap(this.currentKeys(), Date.now()).catch((err: Error) => {
        this.log.error({ err: err.message }, "gap marker publish failed");
      });
    }
  }
}
