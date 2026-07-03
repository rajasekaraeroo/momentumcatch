import WebSocket from "ws";
import type { Tick } from "@momentum-scan/shared";
import type pino from "pino";
import { backoffMs } from "./backoff";
import { FeedState } from "./feed-state";
import type { FeedMetrics } from "./metrics";
import { normalizeFeedResponse } from "./normalize";
import type { FeedDecoder } from "./proto";
import { StarvationMonitor } from "./starvation";
import { TickFilter } from "./tick-filter";

const FEED_URL = "wss://api.upstox.com/v3/feed/market-data-feed";
const MAX_AUTH_FAILURES = 3; // SPEC §12.6.2: don't hammer reconnects on 403

export interface UpstoxFeedSourceDeps {
  /** connection name for logs/health ("A" broad, "B" focus pool — §12.8) */
  name: string;
  /** subscription mode: "full" (D5) or "full_d30" (§12.8 focus pool) */
  mode: string;
  decoder: FeedDecoder;
  /** returns the current access token, or null when not authenticated */
  tokenProvider: () => Promise<string | null>;
  /** current subscription set — re-read on every (re)subscribe so intraday
   *  universe changes survive reconnects */
  instrumentKeys: () => string[];
  onTick: (tick: Tick) => void;
  onState: (state: FeedState) => void;
  metrics: FeedMetrics;
  log: pino.Logger;
  now?: () => number;
}

/**
 * Single Upstox V3 WebSocket connection (SPEC §12.4–§12.6):
 * redirect-following handshake, BINARY subscription frames, protobuf decode,
 * exponential-backoff reconnect with resubscribe, tick-starvation escalation
 * (resubscribe once → reconnect → TICK_STARVED), and 403 → AWAITING_AUTH.
 */
export class UpstoxFeedSource {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private authFailures = 0;
  private resubscribedForStarvation = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private starvationTimer: NodeJS.Timeout | null = null;
  private readonly starvation = new StarvationMonitor();
  private readonly filter = new TickFilter();
  private loggedDecodeErrorThisSession = false;
  private readonly now: () => number;

  constructor(private readonly deps: UpstoxFeedSourceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.starvation.onDisconnected();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.deps.onState(FeedState.STOPPED);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.starvationTimer) clearInterval(this.starvationTimer);
    this.reconnectTimer = null;
    this.starvationTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = await this.deps.tokenProvider();
    if (!token) {
      this.deps.onState(FeedState.AWAITING_AUTH);
      return;
    }
    this.deps.onState(
      this.reconnectAttempt > 0 ? FeedState.RECONNECTING : FeedState.CONNECTING,
    );

    // Two-step handshake: the endpoint 302s to the authorized socket, so the
    // client MUST follow redirects (SPEC §12.4).
    const ws = new WebSocket(FEED_URL, {
      headers: { Authorization: `Bearer ${token}` },
      followRedirects: true,
    });
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      this.deps.log.warn({ status }, "feed connect rejected");
      if (status === 403) {
        this.authFailures += 1;
        if (this.authFailures >= MAX_AUTH_FAILURES) {
          // Token expired or concurrent-connection limit (SPEC §12.6.2):
          // stop hammering, surface AWAITING_AUTH, wait for re-login.
          this.deps.log.warn(
            "403 x%d — awaiting re-authentication, reconnect paused",
            this.authFailures,
          );
          this.clearTimers();
          this.deps.onState(FeedState.AWAITING_AUTH);
          return;
        }
      }
      this.scheduleReconnect();
    });

    ws.on("open", () => {
      this.deps.log.info(
        { keys: this.deps.instrumentKeys().length },
        "feed connected — subscribing",
      );
      this.starvation.onConnected(this.now());
      this.resubscribedForStarvation = false;
      this.filter.reset();
      this.subscribe();
      this.deps.onState(FeedState.LIVE);
      this.startStarvationWatch();
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        // Subscriptions must be binary; server data frames are binary too.
        // A text frame is unexpected — count it as a decode error.
        this.deps.metrics.decodeErrors += 1;
        return;
      }
      this.handleFrame(data as Buffer);
    });

    ws.on("error", (err) => {
      this.deps.log.warn({ err: err.message }, "feed socket error");
    });

    ws.on("close", (code) => {
      this.starvation.onDisconnected();
      if (this.stopped) return;
      this.deps.log.warn({ code }, "feed socket closed");
      this.scheduleReconnect();
    });
  }

  private subscribe(): void {
    this.sendFrame("sub", this.deps.instrumentKeys());
  }

  get name(): string {
    return this.deps.name;
  }

  /** §2 intraday re-centering: sub/unsub diffs, never a full resubscribe. */
  updateSubscriptions(add: string[], remove: string[]): void {
    if (add.length) this.sendFrame("sub", add);
    if (remove.length) this.sendFrame("unsub", remove);
  }

  private sendFrame(method: "sub" | "unsub", instrumentKeys: string[]): void {
    if (instrumentKeys.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    // Binary frame, never text (SPEC §12.4 / known failure mode §12.6.1).
    this.ws.send(
      Buffer.from(
        JSON.stringify({
          guid: `momentum-scan-${this.deps.name}`,
          method,
          data: { mode: this.deps.mode, instrumentKeys },
        }),
      ),
    );
  }

  private handleFrame(buf: Buffer): void {
    const now = this.now();
    let decoded;
    try {
      decoded = this.deps.decoder.decode(buf);
    } catch (err) {
      this.deps.metrics.decodeErrors += 1;
      if (!this.loggedDecodeErrorThisSession) {
        // log first occurrence per session, count the rest (SPEC §12.5)
        this.deps.log.error({ err: (err as Error).message }, "protobuf decode error");
        this.loggedDecodeErrorThisSession = true;
      }
      return;
    }

    if (decoded.type === "market_info") {
      this.deps.metrics.marketInfoFramesTotal += 1;
      this.deps.log.info(
        { segmentStatus: decoded.marketInfo?.segmentStatus },
        "market_info frame",
      );
      return; // NOT tick data (SPEC §12.5)
    }

    this.deps.metrics.dataFramesTotal += 1;
    this.starvation.onDataFrame(now);
    this.reconnectAttempt = 0; // healthy data flow resets backoff
    this.authFailures = 0;

    for (const tick of normalizeFeedResponse(decoded, now)) {
      const verdict = this.filter.check(tick);
      if (verdict.action === "drop-duplicate") {
        this.deps.metrics.duplicatesDropped += 1;
        continue;
      }
      if (verdict.largeSkewMs !== undefined) {
        this.deps.metrics.largeSkewTicks += 1;
        this.deps.log.warn(
          { instrumentKey: tick.instrumentKey, skewMs: verdict.largeSkewMs },
          "large out-of-order timestamp skew",
        );
      }
      this.deps.metrics.onTick(now);
      this.deps.onTick(tick);
    }
  }

  private startStarvationWatch(): void {
    if (this.starvationTimer) clearInterval(this.starvationTimer);
    this.starvationTimer = setInterval(() => {
      if (this.stopped || !this.starvation.isStarved(this.now())) return;
      if (this.deps.instrumentKeys().length === 0) {
        // idle focus-pool connection with zero slots — silence is expected
        this.starvation.onConnected(this.now());
        return;
      }
      // Escalation ladder (SPEC §12.6.1)
      if (!this.resubscribedForStarvation) {
        this.deps.log.warn("tick starvation — resubscribing once");
        this.resubscribedForStarvation = true;
        this.starvation.onConnected(this.now()); // restart the silence clock
        this.subscribe();
        return;
      }
      if (this.reconnectAttempt === 0) {
        this.deps.log.warn("still starved after resubscribe — reconnecting");
        this.reconnectAttempt = 1;
        this.ws?.close();
        return;
      }
      this.deps.onState(FeedState.TICK_STARVED);
    }, 5_000);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.clearTimers();
    this.deps.metrics.reconnects += 1;
    const delay = backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.deps.onState(FeedState.RECONNECTING);
    this.deps.log.info({ delayMs: delay, attempt: this.reconnectAttempt }, "reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
