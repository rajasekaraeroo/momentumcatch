import type { Pool } from "pg";

/**
 * Native-partition helpers for bar_1s (day) and bar_1m_hist (month), shared
 * by the live persistence layer and the historical downloader (SPEC §6,
 * §13.1). Partition bounds are epoch-ms ranges in UTC.
 */

const ensured = new Set<string>();

function dayStartUtc(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function monthStartUtc(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function suffix(d: Date, monthly: boolean): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return monthly ? `${y}${m}` : `${y}${m}${day}`;
}

async function ensureRange(
  pool: Pool,
  table: string,
  from: Date,
  to: Date,
  monthly: boolean,
): Promise<void> {
  const part = `${table}_${suffix(from, monthly)}`;
  if (ensured.has(part)) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${part} PARTITION OF ${table}
     FOR VALUES FROM (${from.getTime()}) TO (${to.getTime()})`,
  );
  ensured.add(part);
}

export async function ensureDayPartition(pool: Pool, table: string, ms: number): Promise<void> {
  const from = dayStartUtc(ms);
  const to = new Date(from.getTime() + 24 * 3600_000);
  await ensureRange(pool, table, from, to, false);
}

export async function ensureMonthPartition(pool: Pool, table: string, ms: number): Promise<void> {
  const from = monthStartUtc(ms);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  await ensureRange(pool, table, from, to, true);
}

/** §6 retention: drop bar_1s day partitions older than `keepDays`. */
export async function dropOldDayPartitions(
  pool: Pool,
  table: string,
  keepDays: number,
  nowMs = Date.now(),
): Promise<string[]> {
  const cutoff = suffix(dayStartUtc(nowMs - keepDays * 24 * 3600_000), false);
  const res = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE tablename LIKE $1 AND tablename ~ $2`,
    [`${table}_%`, `^${table}_[0-9]{8}$`],
  );
  const dropped: string[] = [];
  for (const { tablename } of res.rows) {
    const s = tablename.slice(table.length + 1);
    if (s < cutoff) {
      await pool.query(`DROP TABLE IF EXISTS ${tablename}`);
      ensured.delete(tablename);
      dropped.push(tablename);
    }
  }
  return dropped;
}
