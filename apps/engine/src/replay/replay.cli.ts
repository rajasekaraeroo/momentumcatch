import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Tick } from "@momentum-scan/shared";
import { findRepoRoot } from "../config/config.service";
import { createLogger } from "../logger";
import { FeedMetrics } from "../feed/metrics";
import { TickFilter } from "../feed/tick-filter";
import { Aggregator } from "../momentum/aggregator";
import { MomentumService } from "../momentum/momentum.service";
import { AppConfigService } from "../config/config.service";
import { LifecycleService } from "../lifecycle/lifecycle.service";
import { SignalBus } from "../signals/signal-bus";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { EmissionGate } from "@momentum-scan/shared";
import { FileReplaySource } from "./file-replay.source";

/**
 * `pnpm engine:replay --file data/ticks/2026-07-01.ndjson --speed 10`
 * (SPEC §8). Runs recorded ticks through the same hygiene layer as the live
 * feed (TickFilter) and logs each accepted tick to stdout — the Stage-1
 * acceptance path outside market hours.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      speed: { type: "string", default: "10" },
      /** aggregate to 1s bars + baselines instead of raw tick logging */
      bars: { type: "boolean", default: false },
      /** full pipeline: aggregation → momentum → lifecycle + §8 report
       *  (option metadata from --option key=CE|PE=underlyingKey or
       *  SYNTH_OPTION_KEYS env) */
      report: { type: "boolean", default: false },
      option: { type: "string", multiple: true, default: [] },
    },
  });
  if (!values.file) {
    console.error(
      "usage: pnpm engine:replay --file data/ticks/YYYY-MM-DD.ndjson [--speed 10|max] [--bars]",
    );
    process.exit(2);
  }
  // `pnpm engine:replay` runs with cwd=apps/engine; accept repo-root-relative
  // paths (as documented in the README) as well as cwd-relative ones.
  let file = values.file;
  if (!fs.existsSync(file)) {
    const fromRoot = path.join(findRepoRoot(), file);
    if (fs.existsSync(fromRoot)) file = fromRoot;
  }

  const speed = values.speed === "max" ? Infinity : Number(values.speed);
  if (!Number.isFinite(speed) && values.speed !== "max") {
    console.error(`invalid --speed ${values.speed}`);
    process.exit(2);
  }

  const log = createLogger("replay");
  const tickLog = createLogger("tick");
  const barLog = createLogger("bar");
  const metrics = new FeedMetrics();
  const filter = new TickFilter();
  const perInstrument = new Map<string, number>();
  // Same defaults as config/momentum.yaml windows (SPEC §4).
  const aggregator = values.bars || values.report
    ? new Aggregator({ baselineWindow: 300, openExclusionSec: 300 })
    : null;
  let maxSec = 0;

  // §8 full-pipeline report mode: the exact live services, no Nest container
  let pipeline: {
    momentum: MomentumService;
    lifecycle: LifecycleService;
    events: number;
    lifecycleCounts: Record<string, number>;
    scoreHist: number[];
    wouldFire: Map<number, { gates: Map<string, EmissionGate>; count: number }>;
  } | null = null;
  if (values.report) {
    const config = new AppConfigService();
    const registry = new InstrumentRegistry();
    const specs = [
      ...(values.option as string[]),
      ...(process.env.SYNTH_OPTION_KEYS ?? "").split(",").filter(Boolean),
    ];
    for (const spec of specs) {
      const [key, side, underlyingKey] = spec.split("=");
      if (!key || !side || !underlyingKey) continue;
      registry.registerIndex(underlyingKey, "SYNTH");
      registry.registerOption(key, {
        side: side === "PE" ? -1 : 1,
        underlyingKey,
        underlying: "SYNTH",
        strike: 0,
        expiry: "2099-01-01",
      });
    }
    if (registry.optionKeys().length === 0) {
      console.error(
        "replay --report needs option metadata: --option 'key=CE=underlyingKey'",
      );
      process.exit(2);
    }
    const bus = new SignalBus();
    const momentum = new MomentumService(config, registry, bus);
    const lifecycle = new LifecycleService(config, bus);
    lifecycle.onApplicationBootstrap();
    const state = {
      momentum,
      lifecycle,
      events: 0,
      lifecycleCounts: {} as Record<string, number>,
      scoreHist: Array(10).fill(0) as number[],
      wouldFire: new Map(
        [60, 65, 70, 75, 80].map((t) => [
          t,
          { gates: new Map<string, EmissionGate>(), count: 0 },
        ]),
      ),
    };
    pipeline = state;
    bus.onEvent(() => (state.events += 1));
    bus.onLifecycle((t) => {
      state.lifecycleCounts[t.type] = (state.lifecycleCounts[t.type] ?? 0) + 1;
      log.info({ key: t.episode.instrumentKey, type: t.type }, t.summary);
    });
    bus.onSnapshot((snap) => {
      const bucket = Math.min(9, Math.floor(snap.score / 10));
      state.scoreHist[bucket] = (state.scoreHist[bucket] ?? 0) + 1;
      for (const [threshold, wf] of state.wouldFire) {
        let gate = wf.gates.get(snap.instrumentKey);
        if (!gate) {
          gate = new EmissionGate({
            threshold,
            rearmBelow: config.momentum.emission.rearmBelow,
            cooldownSteps: config.momentum.emission.cooldownSec,
          });
          wf.gates.set(snap.instrumentKey, gate);
        }
        if (
          gate.update(snap.score, snap.liquidityOk, Math.floor(snap.ts / 1000)) ===
          "emit"
        ) {
          wf.count += 1;
        }
      }
    });
  }

  const logBar = (bar: import("@momentum-scan/shared").Bar): void => {
    barLog.info(
      {
        key: bar.instrumentKey,
        ts: bar.ts,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        vol: bar.vol,
        oiDelta: bar.oiDelta,
        imb: bar.bidAskImbalance,
        gap: bar.gap,
      },
      "1s bar",
    );
  };

  log.info({ file, speed: values.speed, bars: values.bars }, "replay starting");
  const source = new FileReplaySource(file, speed);
  await source.start((tick: Tick) => {
    const verdict = filter.check(tick);
    if (verdict.action === "drop-duplicate") {
      metrics.duplicatesDropped += 1;
      return;
    }
    if (verdict.largeSkewMs !== undefined) {
      metrics.largeSkewTicks += 1;
      log.warn(
        { instrumentKey: tick.instrumentKey, skewMs: verdict.largeSkewMs },
        "large out-of-order timestamp skew",
      );
    }
    metrics.onTick(Date.now());
    perInstrument.set(
      tick.instrumentKey,
      (perInstrument.get(tick.instrumentKey) ?? 0) + 1,
    );
    maxSec = Math.max(maxSec, Math.floor(tick.ts / 1000));
    if (aggregator) {
      const closed = aggregator.handleEntries(tick.instrumentKey, [
        { kind: "tick", tick },
      ]);
      if (pipeline) {
        pipeline.momentum.onBars(
          tick.instrumentKey,
          closed,
          aggregator.baselineSnapshot(tick.instrumentKey),
        );
      } else {
        closed.forEach(logBar);
      }
    } else {
      tickLog.info(
        { key: tick.instrumentKey, ts: tick.ts, ltp: tick.ltp, vol: tick.volume, oi: tick.oi },
        "tick",
      );
    }
  });

  const baselines: Record<string, unknown> = {};
  if (aggregator) {
    for (const key of aggregator.activeInstruments()) {
      const closed = aggregator.flush(key, maxSec); // close final buckets
      if (pipeline) {
        pipeline.momentum.onBars(key, closed, aggregator.baselineSnapshot(key));
      } else {
        closed.forEach(logBar);
      }
      baselines[key] = aggregator.baselineSnapshot(key);
    }
  }

  log.info(
    {
      ticksAccepted: metrics.ticksTotal,
      duplicatesDropped: metrics.duplicatesDropped,
      largeSkewTicks: metrics.largeSkewTicks,
      perInstrument: Object.fromEntries(perInstrument),
      ...(aggregator
        ? { barsClosed: aggregator.barsClosedTotal, baselines }
        : {}),
      ...(pipeline
        ? {
            eventsEmitted: pipeline.events,
            lifecycle: pipeline.lifecycleCounts,
            scoreDistribution: Object.fromEntries(
              pipeline.scoreHist.map((n, i) => [`${i * 10}-${i * 10 + 10}`, n]),
            ),
            wouldHaveFiredAtThreshold: Object.fromEntries(
              [...pipeline.wouldFire].map(([t, wf]) => [t, wf.count]),
            ),
          }
        : {}),
    },
    "replay complete",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
