import { describe, expect, it } from "vitest";
import { EpisodeState } from "@momentum-scan/shared";
import type { AppConfigService } from "../config/config.service";
import type { LifecycleService } from "../lifecycle/lifecycle.service";
import type { MomentumService } from "../momentum/momentum.service";
import { SignalBus } from "../signals/signal-bus";
import { FocusPoolService } from "./focus-pool.service";

/** stubs — only the members FocusPoolService touches */
function makeService(opts: {
  enabled: boolean;
  capacity: number;
  scores: Map<string, number>;
  states: Map<string, EpisodeState>;
}) {
  const config = {
    momentum: {
      focusPool: {
        enabled: opts.enabled,
        capacity: opts.capacity,
        demotionCooldownSec: 0,
        imbalanceLambda: 0.25,
        emaWarmupSec: 10,
      },
    },
  } as unknown as AppConfigService;
  const momentum = {
    latestSnapshot: (k: string) =>
      opts.scores.has(k) ? { score: opts.scores.get(k) } : undefined,
  } as unknown as MomentumService;
  const lifecycle = {
    episodeFor: (k: string) =>
      opts.states.has(k) ? { state: opts.states.get(k) } : undefined,
  } as unknown as LifecycleService;
  const svc = new FocusPoolService(config, new SignalBus(), momentum, lifecycle);
  const diffs: { add: string[]; remove: string[] }[] = [];
  svc.onDiff = (add, remove) => diffs.push({ add, remove });
  return { svc, diffs };
}

describe("FocusPoolService (§12.8)", () => {
  it("promotes on episode open and evicts the lowest-score non-FADING slot on overflow", () => {
    const scores = new Map<string, number>();
    const states = new Map<string, EpisodeState>();
    const { svc, diffs } = makeService({ enabled: true, capacity: 3, scores, states });

    for (const [key, score, state] of [
      ["K1", 20, EpisodeState.FADING],
      ["K2", 55, EpisodeState.BUILDING],
      ["K3", 80, EpisodeState.PEAK],
    ] as const) {
      scores.set(key, score);
      states.set(key, state);
      svc.promote(key);
    }
    expect(svc.state().slots).toEqual(["K1", "K2", "K3"]);

    // 4th episode: K2 (lowest non-FADING) is evicted; FADING K1 survives
    scores.set("K4", 90);
    states.set("K4", EpisodeState.BUILDING);
    svc.promote("K4");
    expect(svc.state().slots.sort()).toEqual(["K1", "K3", "K4"]);
    expect(diffs).toContainEqual({ add: [], remove: ["K2"] });
    expect(diffs).toContainEqual({ add: ["K4"], remove: [] });
    expect(svc.isPooled("K1")).toBe(true);
  });

  it("re-promoting a pooled key is a no-op", () => {
    const { svc, diffs } = makeService({
      enabled: true,
      capacity: 3,
      scores: new Map([["K1", 50]]),
      states: new Map([["K1", EpisodeState.BUILDING]]),
    });
    svc.promote("K1");
    svc.promote("K1");
    expect(diffs).toHaveLength(1);
  });

  it("disabled flag → completely inert (pre-Plus behavior untouched)", () => {
    const { svc, diffs } = makeService({
      enabled: false,
      capacity: 3,
      scores: new Map(),
      states: new Map(),
    });
    svc.onApplicationBootstrap();
    svc.promote("K1");
    expect(svc.state()).toEqual({ slots: [], capacity: 3, connectionState: "DISABLED" });
    expect(diffs).toHaveLength(0);
  });
});
