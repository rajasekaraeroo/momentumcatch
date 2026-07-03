import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import {
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server } from "ws";
import WebSocket from "ws";
import { FeedService } from "../feed/feed.service";
import { FocusPoolService } from "../focus-pool/focus-pool.service";
import { LifecycleService } from "../lifecycle/lifecycle.service";
import { SignalBus } from "../signals/signal-bus";

/**
 * WS /live (SPEC §7): pushes per-instrument 1s snapshots (score +
 * components), MomentumEvent, lifecycle transitions, and a feed-health
 * status frame every 5s. Message shape: { type, data }.
 */
@Injectable()
@WebSocketGateway({ path: "/live" })
export class LiveGateway implements OnApplicationBootstrap {
  @WebSocketServer()
  server!: Server;

  private healthTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SignalBus) private readonly bus: SignalBus,
    @Inject(FeedService) private readonly feed: FeedService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(FocusPoolService) private readonly focusPool: FocusPoolService,
  ) {}

  onApplicationBootstrap(): void {
    this.bus.onSnapshot((s) => this.broadcast("snapshot", s));
    this.bus.onEvent((e) => this.broadcast("event", e));
    this.bus.onLifecycle((t) => this.broadcast("lifecycle", t));
    this.bus.onFeedState((state) => this.broadcast("feedState", { state }));
    this.healthTimer = setInterval(() => {
      this.broadcast("health", {
        feed: this.feed.getStatus(),
        episodes: this.lifecycle.activeEpisodes(),
        focusPool: this.focusPool.state(),
      });
    }, 5_000);
    this.healthTimer.unref();
  }

  private broadcast(type: string, data: unknown): void {
    if (!this.server) return;
    const msg = JSON.stringify({ type, data });
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }
}
