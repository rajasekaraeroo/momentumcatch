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
import { TickRecorder } from "./tick-recorder";
import { UpstoxFeedSource } from "./upstox-feed.source";

const SCHEDULER_INTERVAL_MS = 15_000;

export interface FeedStatus {
  state: FeedState;
  subscriptionCount: number;
  protoAvailable: boolean;
  metrics: Record<string, number | null>;
}

/**
 * Feed orchestrator: market-hours scheduling (SPEC §2), token polling
 * (§12.2 — auto-start the moment a token appears), and the Stage-1 tick sink
 * (structured stdout log + optional NDJSON recording, §6).
 *
 * Stage 1 subscribes to the underlying index keys from config/universe.yaml
 * (real keys, no instruments master needed). Option-universe resolution
 * (§12.3) arrives with Stage 2. FEED_KEYS overrides for testing.
 */
@Injectable()
export class FeedService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = createLogger("feed");
  private readonly tickLog = createLogger("tick");
  readonly metrics = new FeedMetrics();

  private state: FeedState = FeedState.AWAITING_AUTH;
  private source: UpstoxFeedSource | null = null;
  private decoder: FeedDecoder | null = null;
  private protoError: string | null = null;
  private recorder: TickRecorder | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private readonly instrumentKeys: string[];

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {
    this.instrumentKeys = config.env.FEED_KEYS
      ? config.env.FEED_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
      : config.universe.underlyings.map((u) => u.indexInstrumentKey);
    if (config.env.RECORD_TICKS) {
      this.recorder = new TickRecorder(
        path.join(config.repoRoot, "data", "ticks"),
      );
    }
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
    await this.source?.stop();
    this.recorder?.close();
  }

  getStatus(): FeedStatus {
    return {
      state: this.state,
      subscriptionCount: this.instrumentKeys.length,
      protoAvailable: this.decoder !== null,
      metrics: this.metrics.snapshot(Date.now()),
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
        await this.source.stop();
        this.source = null;
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
      decoder: this.decoder,
      tokenProvider: () => this.auth.getToken(),
      instrumentKeys: this.instrumentKeys,
      onTick: (tick) => this.handleTick(tick),
      onState: (s) => this.setState(s),
      metrics: this.metrics,
      log: this.log,
    });
    await this.source.start();
  }

  private handleTick(tick: Tick): void {
    // Stage-1 acceptance: decoded ticks on stdout. Later stages fan out to
    // the Redis stream here; the log drops to debug level then.
    this.tickLog.info(
      {
        key: tick.instrumentKey,
        ts: tick.ts,
        ltp: tick.ltp,
        vol: tick.volume,
        oi: tick.oi,
        bid: tick.bidPrice,
        ask: tick.askPrice,
      },
      "tick",
    );
    this.recorder?.record(tick);
  }

  private setState(state: FeedState): void {
    if (state === this.state) return;
    this.log.info({ from: this.state, to: state }, "feed state change");
    this.state = state;
  }
}
