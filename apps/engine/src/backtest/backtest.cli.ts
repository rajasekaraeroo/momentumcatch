import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Bar, MomentumEvent } from "@momentum-scan/shared";
import { AppConfigService } from "../config/config.service";
import { createPool, runMigrations } from "../db/db.module";
import { HistStore } from "../history/hist-store";
import { createLogger } from "../logger";
import { BacktestEngine, type BtInstrument, type ClosedEpisode } from "./backtest-engine";
import { loadBacktestConfig, type BacktestConfig } from "./config";
import { forwardOutcomes } from "./outcomes";
import { writeReport } from "./report";

/**
 * §13.3 backtest runner:
 *   pnpm backtest -- --from 2025-07-01 --to 2026-06-30 --underlying NIFTY
 * Streams bar_1m_hist chronologically per session through the shared
 * momentum + lifecycle code. Sweep mode grids the emission threshold over
 * the tune window (first `tuneMonths`), leaving the holdout untouched;
 * `--final` runs the full range once and writes the §13.4 report.
 */

const log = createLogger("backtest");

interface PendingEvent {
  event: MomentumEvent;
  entryPremium: number;
  minuteIdx: number; // index into the contract's session candle array
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runRange(opts: {
  store: HistStore;
  pool: import("pg").Pool;
  config: AppConfigService;
  bt: BacktestConfig;
  underlying: string;
  from: string;
  to: string;
  runId: string;
  threshold?: number;
  persist: boolean;
}): Promise<{ events: number; episodes: number; sessions: number }> {
  const { store, pool, config, bt, underlying } = opts;
  const live = config.momentum.lifecycle;
  const sessions = await store.sessions(
    underlying,
    Date.parse(opts.from),
    Date.parse(opts.to) + 86_400_000,
  );
  const rand = mulberry(1234);
  let eventCount = 0;
  let episodeCount = 0;

  // The backtest run is NOT resumable (unlike the download) — it recomputes
  // from scratch each time. Clear any rows from a previous run with this
  // run_id first, so re-running (e.g. after an interruption or a threshold
  // change) never double-counts. Cheap: it's local compute, not a re-download.
  if (opts.persist) {
    await pool.query("DELETE FROM momentum_event_bt WHERE run_id = $1", [opts.runId]);
    await pool.query("DELETE FROM momentum_episode_bt WHERE run_id = $1", [opts.runId]);
  }

  for (const day of sessions) {
    const { contracts, candles } = await store.sessionCandles(underlying, day);
    // derive per-contract oiDelta chronologically (stored oi is a level)
    const prevOi = new Map<string, number>();
    for (const c of candles) {
      if (c.oi !== undefined) {
        const p = prevOi.get(c.instrumentKey);
        c.oiDelta = p !== undefined ? c.oi - p : 0;
        prevOi.set(c.instrumentKey, c.oi);
      }
    }

    const instruments = new Map<string, BtInstrument>();
    const indexKey = `INDEX|${underlying}`;
    for (const [key, meta] of contracts) {
      if (key.startsWith("INDEX|") || meta.side === undefined) continue;
      instruments.set(key, {
        key,
        side: meta.side,
        underlyingKey: indexKey,
        strike: meta.strike,
        expiry: meta.expiry,
      });
    }

    // per-contract chronological closes for forward outcomes
    const closesByContract = new Map<string, { ts: number; c: number; vol: number }[]>();
    for (const c of candles) {
      const arr = closesByContract.get(c.instrumentKey) ?? [];
      arr.push({ ts: c.ts, c: c.c, vol: c.vol });
      closesByContract.set(c.instrumentKey, arr);
    }

    const pending: PendingEvent[] = [];
    const closedEpisodes: ClosedEpisode[] = [];
    const engine = new BacktestEngine(
      bt,
      {
        decayWeights: live.decayWeights,
        volumeFadeFloorRatio: live.volumeFadeFloorRatio,
        pullbackAtrK: live.pullbackAtrK,
        fadingAt: live.fadingAt,
        reigniteBelow: live.reigniteBelow,
        deadAt: live.deadAt,
        deadScoreFloor: live.deadScoreFloor,
        maxEpisodeSteps: live.maxEpisodeSec,
      },
      instruments,
      {
        onEvent: (event, snap) => {
          const series = closesByContract.get(event.instrumentKey) ?? [];
          const minuteIdx = series.findIndex((x) => x.ts === event.ts);
          pending.push({ event, entryPremium: snap.premium, minuteIdx });
        },
        onEpisodeClosed: (closed) => closedEpisodes.push(closed),
      },
      opts.threshold,
    );

    engine.newSession();
    const byMinute = new Map<number, Bar[]>();
    for (const c of candles) {
      const arr = byMinute.get(c.ts) ?? [];
      arr.push(c);
      byMinute.set(c.ts, arr);
    }
    for (const ts of [...byMinute.keys()].sort((a, b) => a - b)) {
      engine.step(ts, byMinute.get(ts) as Bar[]);
    }

    // forward outcomes + persistence
    eventCount += pending.length;
    episodeCount += closedEpisodes.length;
    if (opts.persist) {
      const sessionSpot = (closesByContract.get(indexKey) ?? []).slice(-1)[0]?.c ?? 0;
      for (const p of pending) {
        await persistEvent(pool, opts.runId, underlying, p, instruments, closesByContract, bt, sessionSpot, false);
        // §13.4.2 matched random baseline: same contract/session, random
        // timestamps passing the same liquidity gate + warmup
        const series = closesByContract.get(p.event.instrumentKey) ?? [];
        const eligible = series
          .map((x, i) => ({ ...x, i }))
          .filter(
            (x) =>
              x.i >= bt.windows.warmupCandles &&
              x.i < series.length - 2 &&
              x.vol >= bt.liquidityGate.minCandleVolume,
          );
        for (let b = 0; b < bt.evaluation.randomBaselinePerEvent && eligible.length > 0; b++) {
          const pick = eligible[Math.floor(rand() * eligible.length)] as { ts: number; c: number; i: number };
          await persistEvent(
            pool,
            opts.runId,
            underlying,
            {
              event: { ...p.event, id: randomUUID(), ts: pick.ts },
              entryPremium: pick.c,
              minuteIdx: pick.i,
            },
            instruments,
            closesByContract,
            bt,
            sessionSpot,
            true,
          );
        }
      }
      for (const closed of closedEpisodes) {
        const ep = closed.episode;
        const meta = instruments.get(ep.instrumentKey);
        await pool.query(
          `INSERT INTO momentum_episode_bt
             (id, run_id, instrument_key, underlying, direction, opened_at, closed_at,
              state, peak_score, premium_extreme, ignition, decay_evidence,
              giveback_pct, fading_giveback, naive_giveback)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO NOTHING`,
          [
            ep.id, opts.runId, ep.instrumentKey, meta ? underlying : null,
            ep.direction, ep.openedAt, ep.closedAt ?? null, ep.state,
            ep.peak.score, ep.peak.premiumExtreme, JSON.stringify(ep.ignition),
            JSON.stringify(ep.decayEvidence), ep.givebackPct ?? null,
            closed.fadingGiveback, closed.naiveGiveback,
          ],
        );
      }
    }
  }
  return { events: eventCount, episodes: episodeCount, sessions: sessions.length };
}

async function persistEvent(
  pool: import("pg").Pool,
  runId: string,
  underlying: string,
  p: PendingEvent,
  instruments: Map<string, BtInstrument>,
  closes: Map<string, { ts: number; c: number }[]>,
  bt: BacktestConfig,
  sessionSpot: number,
  isBaseline: boolean,
): Promise<void> {
  const series = closes.get(p.event.instrumentKey) ?? [];
  const fwd = series.slice(p.minuteIdx + 1).map((x) => x.c);
  const o = forwardOutcomes(p.entryPremium, p.event.direction, fwd, bt.evaluation.horizonsMin);
  const meta = instruments.get(p.event.instrumentKey);
  const strike = meta?.strike ?? 0;
  const side = meta?.side ?? 1;
  const dist = sessionSpot > 0 ? (strike - sessionSpot) * side : 0;
  const moneyness =
    Math.abs(strike - sessionSpot) <= 75 ? "ATM" : dist < 0 ? "ITM" : "OTM";
  await pool.query(
    `INSERT INTO momentum_event_bt
       (id, run_id, ts, instrument_key, underlying, strike, side, moneyness,
        direction, score, classification, evidence, episode_id, is_baseline,
        fwd_returns, mfe, mae, time_to_peak_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO NOTHING`,
    [
      p.event.id, runId, p.event.ts, p.event.instrumentKey, underlying,
      meta?.strike ?? null, meta?.side ?? null, moneyness,
      p.event.direction, p.event.score, p.event.classification,
      JSON.stringify({ components: p.event.components }),
      p.event.episodeId, isBaseline,
      JSON.stringify(o.fwdReturns), o.mfe, o.mae, o.timeToPeakMin,
    ],
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      underlying: { type: "string", default: "NIFTY" },
      config: { type: "string", default: "config/backtest.yaml" },
      "run-id": { type: "string" },
      sweep: { type: "boolean", default: false },
      synthetic: { type: "boolean", default: false },
    },
    // pnpm passes a literal "--" through sometimes
    args: process.argv.slice(2).filter((a) => a !== "--"),
  });
  if (!values.from || !values.to) {
    console.error("usage: pnpm backtest -- --from YYYY-MM-DD --to YYYY-MM-DD --underlying NIFTY [--sweep] [--synthetic]");
    process.exit(2);
  }
  const config = new AppConfigService();
  const bt = loadBacktestConfig(config.repoRoot, values.config as string);
  const pool = createPool(config.env.DATABASE_URL);
  await runMigrations(pool, `${config.repoRoot}/apps/engine`);
  const store = new HistStore(pool);
  const underlying = values.underlying as string;

  if (values.sweep) {
    // §13.3 parameter sweep on months 1–tuneMonths only; holdout untouched
    const fromMs = Date.parse(values.from as string);
    const tuneEnd = new Date(fromMs);
    tuneEnd.setUTCMonth(tuneEnd.getUTCMonth() + bt.evaluation.tuneMonths);
    const tuneTo = tuneEnd.toISOString().slice(0, 10);
    log.info({ tuneTo }, "sweep over the tune window (holdout untouched)");
    const rows: Record<string, unknown>[] = [];
    for (const threshold of [60, 65, 70, 75, 80]) {
      const res = await runRange({
        store, pool, config, bt, underlying,
        from: values.from as string,
        to: tuneTo,
        runId: `sweep-${threshold}`,
        threshold,
        persist: false,
      });
      rows.push({ threshold, ...res });
      log.info({ threshold, ...res }, "sweep row");
    }
    console.table(rows);
    await pool.end();
    return;
  }

  const runId =
    (values["run-id"] as string | undefined) ??
    `${values.synthetic ? "SYNTHETIC-" : ""}${underlying}-${values.from}-${values.to}-${Date.now()}`;
  log.info({ runId }, "backtest starting");
  const res = await runRange({
    store, pool, config, bt, underlying,
    from: values.from as string,
    to: values.to as string,
    runId,
    persist: true,
  });
  log.info(res, "backtest complete — writing report");
  const paths = await writeReport(pool, config.repoRoot, runId, bt, {
    underlying,
    from: values.from as string,
    to: values.to as string,
    synthetic: Boolean(values.synthetic) || runId.startsWith("SYNTHETIC"),
    sessions: res.sessions,
  });
  log.info(paths, "report written");
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
