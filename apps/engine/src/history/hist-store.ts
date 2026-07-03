import type { Pool } from "pg";
import type { Bar } from "@momentum-scan/shared";
import { ensureMonthPartition } from "../persistence/partitions";

/**
 * bar_1m_hist access (SPEC §13.1): month-partitioned candle storage,
 * resumable download checkpoints, and data-quality gap registry.
 * Index candles are stored under expired_instrument_key = "INDEX|{symbol}".
 */

export interface HistContract {
  expiredInstrumentKey: string;
  underlying: string;
  strike?: number;
  side?: 1 | -1;
  expiry?: string; // YYYY-MM-DD
}

export class HistStore {
  constructor(private readonly pool: Pool) {}

  async saveCandles(contract: HistContract, candles: Bar[]): Promise<number> {
    if (candles.length === 0) return 0;
    const months = new Set(
      candles.map((c) => `${new Date(c.ts).getUTCFullYear()}-${new Date(c.ts).getUTCMonth()}`),
    );
    for (const m of months) {
      const [y, mo] = m.split("-").map(Number);
      await ensureMonthPartition(this.pool, "bar_1m_hist", Date.UTC(y as number, mo as number, 1));
    }
    const cols = 11;
    // chunk to stay under parameter limits
    let written = 0;
    for (let off = 0; off < candles.length; off += 2_000) {
      const chunk = candles.slice(off, off + 2_000);
      const values: unknown[] = [];
      const rows = chunk.map((c, i) => {
        values.push(
          contract.expiredInstrumentKey, contract.underlying,
          contract.strike ?? null, contract.side ?? null, contract.expiry ?? null,
          c.ts, c.o, c.h, c.l, c.c, c.vol,
        );
        const base = i * cols;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},${c.oi ?? "NULL"})`;
      });
      await this.pool.query(
        `INSERT INTO bar_1m_hist
           (expired_instrument_key, underlying, strike, side, expiry, ts, o, h, l, c, vol, oi)
         VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
        values,
      );
      written += chunk.length;
    }
    return written;
  }

  async checkpoint(contractKey: string, status: string, detail?: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO hist_download_progress (contract_key, status, detail, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (contract_key) DO UPDATE
         SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`,
      [contractKey, status, detail ? JSON.stringify(detail) : null, Date.now()],
    );
  }

  async isDone(contractKey: string): Promise<boolean> {
    const r = await this.pool.query(
      "SELECT 1 FROM hist_download_progress WHERE contract_key = $1 AND status = 'done'",
      [contractKey],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recordGap(key: string, sessionDate: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO hist_gaps (expired_instrument_key, session_date, reason)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [key, sessionDate, reason],
    );
  }

  /** distinct session dates (IST) with candles for an underlying's options */
  async sessions(underlying: string, fromMs: number, toMs: number): Promise<string[]> {
    const r = await this.pool.query<{ d: string }>(
      `SELECT DISTINCT to_char(to_timestamp(ts/1000.0) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d
       FROM bar_1m_hist
       WHERE underlying = $1 AND ts BETWEEN $2 AND $3
         AND expired_instrument_key NOT LIKE 'INDEX|%'
       ORDER BY d`,
      [underlying, fromMs, toMs],
    );
    return r.rows.map((x) => x.d);
  }

  /** all candles for one IST session, ordered by ts, options + index */
  async sessionCandles(
    underlying: string,
    sessionDate: string,
  ): Promise<{ contracts: Map<string, HistContract>; candles: Bar[] }> {
    const from = new Date(`${sessionDate}T00:00:00+05:30`).getTime();
    const to = from + 24 * 3600_000;
    const r = await this.pool.query(
      `SELECT expired_instrument_key AS k, underlying, strike, side, expiry,
              ts, o, h, l, c, vol, oi
       FROM bar_1m_hist
       WHERE underlying = $1 AND ts >= $2 AND ts < $3
       ORDER BY ts`,
      [underlying, from, to],
    );
    const contracts = new Map<string, HistContract>();
    const candles: Bar[] = [];
    for (const row of r.rows) {
      if (!contracts.has(row.k)) {
        contracts.set(row.k, {
          expiredInstrumentKey: row.k,
          underlying: row.underlying,
          strike: row.strike ?? undefined,
          side: row.side ?? undefined,
          expiry: row.expiry ? String(row.expiry).slice(0, 10) : undefined,
        });
      }
      candles.push({
        instrumentKey: row.k,
        ts: Number(row.ts),
        o: row.o, h: row.h, l: row.l, c: row.c,
        vol: row.vol,
        oiDelta: 0, // derived by the engine consumer from oi below
        oi: row.oi ?? undefined,
        vwapNum: 0,
        vwapDen: 0,
      });
    }
    return { contracts, candles };
  }

  async excludedSessions(underlying: string): Promise<Set<string>> {
    const r = await this.pool.query<{ d: string }>(
      `SELECT DISTINCT to_char(session_date, 'YYYY-MM-DD') AS d FROM hist_gaps
       WHERE expired_instrument_key LIKE '%' || $1 || '%' OR expired_instrument_key LIKE 'INDEX|%'`,
      [underlying],
    );
    return new Set(r.rows.map((x) => x.d));
  }
}
