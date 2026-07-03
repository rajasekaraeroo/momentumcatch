import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/db.module";
import {
  dropOldDayPartitions,
  ensureDayPartition,
  ensureMonthPartition,
} from "../src/persistence/partitions";

/**
 * Integration test for the §6 schema, partitioning and retention against a
 * real PostgreSQL (local, port 5433). Self-skips when unreachable.
 */

const PG_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://momentum:momentum@127.0.0.1:5433/momentumscan";

async function pgAvailable(): Promise<Pool | null> {
  const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 800, max: 2 });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

describe("PostgreSQL persistence (SPEC §6)", () => {
  let pool: Pool | null = null;

  beforeAll(async () => {
    pool = await pgAvailable();
    if (!pool) return;
    await runMigrations(pool, `${__dirname}/..`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("applies migrations idempotently", async (ctx) => {
    if (!pool) return ctx.skip();
    await runMigrations(pool, `${__dirname}/..`); // second run is a no-op
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const t of [
      "bar_1s",
      "momentum_event",
      "momentum_episode",
      "session_stats",
      "feed_health",
      "instrument_universe",
      "bar_1m_hist",
      "hist_download_progress",
      "hist_gaps",
      "momentum_event_bt",
      "momentum_episode_bt",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("writes bars into day partitions and retention drops old ones", async (ctx) => {
    if (!pool) return ctx.skip();
    const now = Date.now();
    const old = now - 40 * 86_400_000; // 40 days ago — beyond retention
    await ensureDayPartition(pool, "bar_1s", now);
    await ensureDayPartition(pool, "bar_1s", old);
    await pool.query(
      `INSERT INTO bar_1s (instrument_key, ts, o, h, l, c, vol, oi_delta)
       VALUES ('SYNTH_FO|SAMPLE_CE', $1, 100, 101, 99, 100.5, 250, 10),
              ('SYNTH_FO|SAMPLE_CE', $2, 90, 91, 89, 90.5, 100, -5)
       ON CONFLICT DO NOTHING`,
      [now, old],
    );
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM bar_1s WHERE instrument_key='SYNTH_FO|SAMPLE_CE'",
    );
    expect(before.rows[0].n).toBeGreaterThanOrEqual(2);

    const dropped = await dropOldDayPartitions(pool, "bar_1s", 30, now);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    const after = await pool.query(
      "SELECT count(*)::int AS n FROM bar_1s WHERE ts < $1",
      [now - 30 * 86_400_000],
    );
    expect(after.rows[0].n).toBe(0);
  });

  it("supports month partitions for bar_1m_hist", async (ctx) => {
    if (!pool) return ctx.skip();
    const ts = Date.UTC(2026, 0, 15);
    await ensureMonthPartition(pool, "bar_1m_hist", ts);
    await pool.query(
      `INSERT INTO bar_1m_hist (expired_instrument_key, underlying, ts, o, h, l, c, vol, oi)
       VALUES ('NSE_FO|123|15-01-2026', 'NIFTY', $1, 100, 102, 99, 101, 5000, 100000)
       ON CONFLICT DO NOTHING`,
      [ts],
    );
    const res = await pool.query(
      "SELECT count(*)::int AS n FROM bar_1m_hist WHERE ts = $1",
      [ts],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("upserts session_stats and episode rows", async (ctx) => {
    if (!pool) return ctx.skip();
    const id = "00000000-0000-4000-8000-000000000001";
    for (const score of [72, 88]) {
      await pool.query(
        `INSERT INTO session_stats (session_date, instrument_key, event_count, max_score)
         VALUES (CURRENT_DATE, 'SYNTH_FO|SAMPLE_CE', 1, $1)
         ON CONFLICT (session_date, instrument_key)
         DO UPDATE SET event_count = session_stats.event_count + 1,
                       max_score = GREATEST(session_stats.max_score, EXCLUDED.max_score)`,
        [score],
      );
    }
    const stats = await pool.query(
      "SELECT event_count, max_score FROM session_stats WHERE instrument_key='SYNTH_FO|SAMPLE_CE'",
    );
    expect(stats.rows[0].max_score).toBe(88);

    await pool.query(
      `INSERT INTO momentum_episode (id, instrument_key, direction, opened_at, state, ignition)
       VALUES ($1, 'SYNTH_FO|SAMPLE_CE', 1, $2, 'BUILDING', '{}')
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`,
      [id, Date.now()],
    );
    await pool.query(
      `INSERT INTO momentum_episode (id, instrument_key, direction, opened_at, state, ignition)
       VALUES ($1, 'SYNTH_FO|SAMPLE_CE', 1, $2, 'DEAD', '{}')
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`,
      [id, Date.now()],
    );
    const ep = await pool.query("SELECT state FROM momentum_episode WHERE id = $1", [id]);
    expect(ep.rows[0].state).toBe("DEAD");
  });
});
