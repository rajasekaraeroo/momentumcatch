import "dotenv/config";
import { parseArgs } from "node:util";
import type { Bar } from "@momentum-scan/shared";
import { loadBacktestConfig } from "../backtest/config";
import { AppConfigService } from "../config/config.service";
import { createPool, runMigrations } from "../db/db.module";
import { createLogger } from "../logger";
import { HistStore } from "./hist-store";

/**
 * SYNTHETIC one-year 1-minute dataset generator — pipeline validation ONLY.
 *
 * The real Track-A data comes from the Upstox Expired Instruments APIs
 * (backtest:download), which need an Upstox Plus login and network access.
 * This generator produces a deterministic (seeded) year of plausible NIFTY
 * index + weekly-option candles with injected momentum bursts so the
 * downloader→storage→backtest→report pipeline can be exercised end-to-end.
 * Every run/report produced from it is labeled SYNTHETIC. Results carry NO
 * information about real markets.
 */

const log = createLogger("synth");

/** deterministic PRNG (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SESSION_MINUTES = 375; // 09:15–15:30 IST
const STRIKE_STEP = 50;

interface Burst {
  startMin: number;
  lenMin: number;
  dir: 1 | -1;
  magPerMin: number; // index return per minute during the burst
}

function sessionOpenUtc(dateIst: string): number {
  return new Date(`${dateIst}T09:15:00+05:30`).getTime();
}

function tradingDays(from: string, to: string, holidays: Set<string>): string[] {
  const days: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow === 0 || dow === 6 || holidays.has(iso)) continue;
    days.push(iso);
  }
  return days;
}

/** next Thursday ≥ date (weekly expiry) */
function weeklyExpiry(dateIst: string): string {
  const d = new Date(`${dateIst}T00:00:00Z`);
  const add = (4 - d.getUTCDay() + 7) % 7;
  return new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
}

/** crude premium model: intrinsic + decaying time value scaled by moneyness */
function premium(spot: number, strike: number, side: 1 | -1, daysToExpiry: number, ivish: number): number {
  const intrinsic = Math.max(0, side * (spot - strike));
  const dist = Math.abs(spot - strike) / spot;
  const timeValue =
    spot * ivish * Math.sqrt(Math.max(daysToExpiry, 0.05) / 365) * Math.exp(-dist * 55);
  return Math.max(0.05, intrinsic + timeValue);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: "string", default: "2025-07-01" },
      to: { type: "string", default: "2026-06-30" },
      underlying: { type: "string", default: "NIFTY" },
      seed: { type: "string", default: "42" },
    },
  });
  const config = new AppConfigService();
  const bt = loadBacktestConfig(config.repoRoot);
  const pool = createPool(config.env.DATABASE_URL);
  await runMigrations(pool, `${config.repoRoot}/apps/engine`);
  const store = new HistStore(pool);
  const rand = rng(Number(values.seed));
  const days = tradingDays(values.from as string, values.to as string, config.holidays);
  log.warn(
    { days: days.length, seed: values.seed },
    "generating SYNTHETIC dataset — pipeline validation only, not market data",
  );

  let spot = 24_000;
  let generated = 0;
  for (const day of days) {
    const open = sessionOpenUtc(day);
    const expiry = weeklyExpiry(day);
    const daysToExpiry = (Date.parse(expiry) - Date.parse(day)) / 86_400_000;
    const ivish = 0.11 + 0.05 * rand();
    // 0–3 bursts per session
    const bursts: Burst[] = [];
    const nBursts = rand() < 0.25 ? 0 : rand() < 0.6 ? 1 : rand() < 0.85 ? 2 : 3;
    for (let b = 0; b < nBursts; b++) {
      bursts.push({
        startMin: 35 + Math.floor(rand() * 300),
        lenMin: 5 + Math.floor(rand() * 11),
        dir: rand() < 0.5 ? 1 : -1,
        magPerMin: 0.0004 + rand() * 0.0007,
      });
    }

    // index path
    const idxCandles: Bar[] = [];
    let px = spot;
    const drift = (rand() - 0.5) * 0.0008;
    for (let m = 0; m < SESSION_MINUTES; m++) {
      const burst = bursts.find((b) => m >= b.startMin && m < b.startMin + b.lenMin);
      const shock = (rand() - 0.5) * 0.0006 + drift / SESSION_MINUTES;
      const r = (burst ? burst.dir * burst.magPerMin : 0) + shock;
      const o = px;
      px *= 1 + r;
      idxCandles.push({
        instrumentKey: `INDEX|${values.underlying}`,
        ts: open + m * 60_000,
        o,
        h: Math.max(o, px) * (1 + rand() * 0.0002),
        l: Math.min(o, px) * (1 - rand() * 0.0002),
        c: px,
        vol: 0,
        oiDelta: 0,
        vwapNum: 0,
        vwapDen: 0,
      });
    }
    await store.saveCandles(
      { expiredInstrumentKey: `INDEX|${values.underlying}`, underlying: values.underlying as string },
      idxCandles,
    );

    // options: ATM±6 from the session's opening spot
    const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
    for (let k = -bt.download.atmRange; k <= bt.download.atmRange; k++) {
      const strike = atm + k * STRIKE_STEP;
      for (const side of [1, -1] as const) {
        const key = `NSE_FO|SYN${strike}${side === 1 ? "CE" : "PE"}|${expiry}`;
        const candles: Bar[] = [];
        let oi = 200_000 + Math.floor(rand() * 300_000);
        let prem = premium(idxCandles[0]?.o ?? spot, strike, side, daysToExpiry, ivish);
        for (let m = 0; m < SESSION_MINUTES; m++) {
          const idxC = idxCandles[m] as Bar;
          const burst = bursts.find((b) => m >= b.startMin && m < b.startMin + b.lenMin);
          const favorable = burst && burst.dir === side;
          const fair = premium(idxC.c, strike, side, daysToExpiry - m / SESSION_MINUTES / 6.25, ivish);
          // premium mean-reverts to fair with idiosyncratic noise
          const o = prem;
          prem = fair * (1 + (rand() - 0.5) * 0.004);
          const baseVol = 200 + rand() * 400;
          const vol = favorable ? baseVol * (4 + rand() * 5) : baseVol;
          const dOi = favorable
            ? Math.floor((rand() * 2 - 0.4) * 2_000)
            : Math.floor((rand() - 0.5) * 400);
          oi = Math.max(0, oi + dOi);
          candles.push({
            instrumentKey: key,
            ts: open + m * 60_000,
            o,
            h: Math.max(o, prem) * (1 + rand() * 0.001),
            l: Math.min(o, prem) * (1 - rand() * 0.001),
            c: prem,
            vol,
            oiDelta: 0,
            oi,
            vwapNum: 0,
            vwapDen: 0,
          });
        }
        await store.saveCandles(
          {
            expiredInstrumentKey: key,
            underlying: values.underlying as string,
            strike,
            side,
            expiry,
          },
          candles,
        );
        generated += candles.length;
      }
    }
    spot = px;
    if (days.indexOf(day) % 20 === 0) {
      log.info({ day, generated }, "progress");
    }
  }
  await pool.end();
  log.info({ sessions: days.length, candles: generated }, "synthetic dataset complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
