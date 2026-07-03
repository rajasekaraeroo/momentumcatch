import "dotenv/config";
import { parseArgs } from "node:util";
import Redis from "ioredis";
import { AppConfigService } from "../config/config.service";
import { loadBacktestConfig } from "../backtest/config";
import { createPool, runMigrations } from "../db/db.module";
import { createLogger } from "../logger";
import { toIst } from "../feed/market-hours";
import { HistStore } from "./hist-store";
import { UpstoxHistClient } from "./upstox-hist.client";

/**
 * §13.1 historical downloader:
 *   pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY
 * Per-session ATM from the index 1m history → ATM ± N contracts of each
 * weekly expiry → 1m candles via the Expired Instruments API. Resumable
 * (hist_download_progress), rate-limited, data-quality gaps recorded.
 * Requires Upstox Plus + a valid daily token (Redis upstox:token).
 */

const log = createLogger("hist-dl");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      underlying: { type: "string", default: "NIFTY" },
    },
  });
  if (!values.from || !values.to) {
    console.error("usage: pnpm backtest:download --from YYYY-MM-DD --to YYYY-MM-DD --underlying NIFTY");
    process.exit(2);
  }
  const config = new AppConfigService();
  const bt = loadBacktestConfig(config.repoRoot);
  const underlying = config.universe.underlyings.find((u) => u.symbol === values.underlying);
  if (!underlying) throw new Error(`unknown underlying ${values.underlying}`);

  const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const token = await redis.get("upstox:token");
  redis.disconnect();
  if (!token) {
    throw new Error(
      "no Upstox token in Redis — complete the morning login (GET /auth/login) first",
    );
  }
  const pool = createPool(config.env.DATABASE_URL);
  // create the schema if the engine hasn't already (idempotent — a no-op
  // when the tables exist), so the downloader works even on a fresh DB
  await runMigrations(pool, `${config.repoRoot}/apps/engine`);
  const store = new HistStore(pool);
  const api = new UpstoxHistClient(token, bt.download.requestsPerSecond);

  // 1. index 1m history (chunked by month), stored as INDEX|{symbol}
  const indexKey = `INDEX|${underlying.symbol}`;
  log.info({ from: values.from, to: values.to }, "downloading index 1m history");
  for (let d = new Date(`${values.from}T00:00:00Z`); d < new Date(`${values.to}T00:00:00Z`); ) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const chunkTo = next < new Date(`${values.to}T00:00:00Z`) ? next : new Date(`${values.to}T00:00:00Z`);
    const candles = await api.indexCandles1m(
      underlying.indexInstrumentKey,
      d.toISOString().slice(0, 10),
      chunkTo.toISOString().slice(0, 10),
    );
    await store.saveCandles(
      { expiredInstrumentKey: indexKey, underlying: underlying.symbol },
      candles,
    );
    d = next;
  }

  // 2. per-session previous close → session ATM
  const idx = await store.sessionCandles(underlying.symbol, values.from); // seed types
  void idx;
  const sessionsRes = await pool.query<{ d: string; close: number }>(
    `SELECT to_char(to_timestamp(ts/1000.0) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS d,
            (array_agg(c ORDER BY ts DESC))[1] AS close
     FROM bar_1m_hist WHERE expired_instrument_key = $1 AND ts BETWEEN $2 AND $3
     GROUP BY 1 ORDER BY 1`,
    [indexKey, Date.parse(values.from), Date.parse(values.to) + 86_400_000],
  );
  const sessions = sessionsRes.rows;
  const prevClose = new Map<string, number>();
  sessions.forEach((s, i) => {
    if (i > 0) prevClose.set(s.d, (sessions[i - 1] as { close: number }).close);
  });
  log.info({ sessions: sessions.length }, "index history stored");

  // 3. expiries in range → contracts ATM±N per covered session
  const expiries = (await api.expiries(underlying.indexInstrumentKey))
    .filter((e) => e >= (values.from as string) && e <= (values.to as string))
    .sort();
  log.info({ expiries: expiries.length }, "expiries in range");

  let prevExpiry = "";
  for (const expiry of expiries) {
    const covered = sessions
      .map((s) => s.d)
      .filter((d) => d <= expiry && (prevExpiry === "" || d > prevExpiry));
    prevExpiry = expiry;
    if (covered.length === 0) continue;
    const strikes = new Set<number>();
    for (const d of covered) {
      const pc = prevClose.get(d);
      if (pc === undefined) continue;
      const atm = Math.round(pc / underlying.strikeStep) * underlying.strikeStep;
      for (let k = -bt.download.atmRange; k <= bt.download.atmRange; k++) {
        strikes.add(atm + k * underlying.strikeStep);
      }
    }
    const contracts = (await api.optionContracts(underlying.indexInstrumentKey, expiry)).filter(
      (c) => strikes.has(c.strike),
    );
    log.info({ expiry, contracts: contracts.length }, "downloading expiry");

    for (const c of contracts) {
      if (await store.isDone(c.expiredInstrumentKey)) continue;
      try {
        const fromD = covered[0] as string;
        const candles = await api.expiredCandles1m(c.expiredInstrumentKey, fromD, expiry);
        if (candles.length === 0) {
          // known empty-candle issue for some expiries (§13.1) — exclude, don't
          // silently produce zero signals
          await store.recordGap(c.expiredInstrumentKey, expiry, "empty_response");
          await store.checkpoint(c.expiredInstrumentKey, "empty");
          continue;
        }
        // per-session quality: sessions with <300 candles are excluded
        const bySession = new Map<string, number>();
        for (const b of candles) {
          const d = toIst(b.ts).dateIst;
          bySession.set(d, (bySession.get(d) ?? 0) + 1);
        }
        for (const [d, n] of bySession) {
          if (n < 300) await store.recordGap(c.expiredInstrumentKey, d, `short_session_${n}`);
        }
        await store.saveCandles(
          {
            expiredInstrumentKey: c.expiredInstrumentKey,
            underlying: underlying.symbol,
            strike: c.strike,
            side: c.side,
            expiry: c.expiry,
          },
          candles,
        );
        await store.checkpoint(c.expiredInstrumentKey, "done", { candles: candles.length });
      } catch (err) {
        await store.checkpoint(c.expiredInstrumentKey, "failed", {
          err: (err as Error).message,
        });
        log.error({ key: c.expiredInstrumentKey, err: (err as Error).message }, "contract failed");
      }
    }
  }
  await pool.end();
  log.info("download complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
