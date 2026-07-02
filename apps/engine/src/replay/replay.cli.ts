import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Tick } from "@momentum-scan/shared";
import { findRepoRoot } from "../config/config.service";
import { createLogger } from "../logger";
import { FeedMetrics } from "../feed/metrics";
import { TickFilter } from "../feed/tick-filter";
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
    },
  });
  if (!values.file) {
    console.error(
      "usage: pnpm engine:replay --file data/ticks/YYYY-MM-DD.ndjson [--speed 10|max]",
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
  const metrics = new FeedMetrics();
  const filter = new TickFilter();
  const perInstrument = new Map<string, number>();

  log.info({ file, speed: values.speed }, "replay starting");
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
    tickLog.info(
      { key: tick.instrumentKey, ts: tick.ts, ltp: tick.ltp, vol: tick.volume, oi: tick.oi },
      "tick",
    );
  });

  log.info(
    {
      ticksAccepted: metrics.ticksTotal,
      duplicatesDropped: metrics.duplicatesDropped,
      largeSkewTicks: metrics.largeSkewTicks,
      perInstrument: Object.fromEntries(perInstrument),
    },
    "replay complete",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
