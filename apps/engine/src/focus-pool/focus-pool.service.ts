import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { FocusPoolState } from "@momentum-scan/shared";
import { LifecycleEventType } from "@momentum-scan/shared";
import { AppConfigService } from "../config/config.service";
import { LifecycleService } from "../lifecycle/lifecycle.service";
import { createLogger } from "../logger";
import { MomentumService } from "../momentum/momentum.service";
import { SignalBus } from "../signals/signal-bus";
import { pickEviction, type PoolCandidate } from "./eviction";

/**
 * §12.8 D30 focus pool: instruments with OPEN episodes get promoted to
 * Connection B (full_d30, max `capacity` slots). Demotion happens on
 * MomentumDead + cooldown; overflow evicts per the pickEviction policy
 * (FADING slots are protected). Entirely inert when focusPool.enabled is
 * false — pre-Plus behavior is untouched.
 */
@Injectable()
export class FocusPoolService implements OnApplicationBootstrap {
  private readonly log = createLogger("focus-pool");
  private readonly slots = new Set<string>();
  private readonly demotionTimers = new Map<string, NodeJS.Timeout>();
  private connectionState = "DISABLED";

  /** wired by FeedService — sub/unsub diffs for Connection B */
  onDiff: ((add: string[], remove: string[]) => void) | null = null;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(SignalBus) private readonly bus: SignalBus,
    @Inject(MomentumService) private readonly momentum: MomentumService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
  ) {}

  get enabled(): boolean {
    return this.config.momentum.focusPool.enabled;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.bus.onEvent((e) => this.promote(e.instrumentKey));
    this.bus.onLifecycle((t) => {
      if (t.type === LifecycleEventType.MOMENTUM_DEAD) {
        this.scheduleDemotion(t.episode.instrumentKey);
      }
    });
    this.log.info(
      { capacity: this.config.momentum.focusPool.capacity },
      "focus pool active (Upstox Plus full_d30)",
    );
  }

  isPooled(key: string): boolean {
    return this.slots.has(key);
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
  }

  state(): FocusPoolState {
    return {
      slots: [...this.slots],
      capacity: this.config.momentum.focusPool.capacity,
      connectionState: this.enabled ? this.connectionState : "DISABLED",
    };
  }

  promote(key: string): void {
    if (!this.enabled) return;
    // a fresh episode during the demotion cooldown keeps the slot
    const pending = this.demotionTimers.get(key);
    if (pending) {
      clearTimeout(pending);
      this.demotionTimers.delete(key);
    }
    if (this.slots.has(key)) return;

    if (this.slots.size >= this.config.momentum.focusPool.capacity) {
      const victim = pickEviction(this.candidates());
      if (victim === null) return;
      this.log.info({ victim, for: key }, "focus pool full — evicting lowest-score slot");
      this.demote(victim);
    }
    this.slots.add(key);
    this.log.info({ key, occupancy: `${this.slots.size}/${this.config.momentum.focusPool.capacity}` }, "promoted to D30 focus pool");
    this.onDiff?.([key], []);
  }

  private candidates(): PoolCandidate[] {
    return [...this.slots].map((key) => ({
      key,
      state: this.lifecycle.episodeFor(key)?.state,
      score: this.momentum.latestSnapshot(key)?.score ?? 0,
    }));
  }

  private scheduleDemotion(key: string): void {
    if (!this.slots.has(key) || this.demotionTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.demotionTimers.delete(key);
      this.demote(key);
    }, this.config.momentum.focusPool.demotionCooldownSec * 1000);
    timer.unref();
    this.demotionTimers.set(key, timer);
  }

  private demote(key: string): void {
    if (!this.slots.delete(key)) return;
    this.log.info({ key }, "demoted from focus pool — back to D5");
    this.onDiff?.([], [key]);
  }
}
