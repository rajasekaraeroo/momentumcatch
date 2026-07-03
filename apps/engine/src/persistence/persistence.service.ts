import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Pool } from "pg";
import type {
  Bar,
  Episode,
  LifecycleTransition,
  MomentumEvent,
} from "@momentum-scan/shared";
import { LifecycleEventType } from "@momentum-scan/shared";
import { PG } from "../db/db.module";
import { createLogger } from "../logger";
import { SignalBus } from "../signals/signal-bus";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { dropOldDayPartitions, ensureDayPartition } from "./partitions";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER = 2_000;
const RETENTION_DAYS = 30;

/**
 * Best-effort PostgreSQL persistence (SPEC §6): batched 1s bars into day
 * partitions with a 30-day retention job, momentum events, episode
 * lifecycle upserts (decayed_at backfill on FADING), session stats, and
 * feed-health log. A down database never stalls the pipeline — writes are
 * dropped and counted.
 */
@Injectable()
export class PersistenceService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = createLogger("persist");
  private barBuffer: Bar[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  writeErrors = 0;
  barsWritten = 0;

  constructor(
    @Inject(PG) private readonly pool: Pool | null,
    @Inject(SignalBus) private readonly bus: SignalBus,
    @Inject(InstrumentRegistry) private readonly registry: InstrumentRegistry,
  ) {}

  get enabled(): boolean {
    return this.pool !== null;
  }

  onApplicationBootstrap(): void {
    if (!this.pool) return;
    this.bus.onEvent((e) => void this.saveEvent(e).catch((err) => this.fail(err)));
    this.bus.onLifecycle((t) => void this.saveLifecycle(t).catch((err) => this.fail(err)));
    this.bus.onFeedState((state, detail) =>
      void this.saveFeedHealth(state, detail).catch((err) => this.fail(err)),
    );
    this.flushTimer = setInterval(() => void this.flushBars(), FLUSH_INTERVAL_MS);
    this.retentionTimer = setInterval(
      () => void this.retention(),
      6 * 3600_000,
    );
    void this.retention();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.flushBars();
  }

  private fail(err: unknown): void {
    this.writeErrors += 1;
    if (this.writeErrors === 1 || this.writeErrors % 500 === 0) {
      this.log.error({ err: (err as Error).message, total: this.writeErrors }, "pg write failed");
    }
  }

  /** called by AggregationService with each batch of closed bars */
  bufferBars(bars: Bar[]): void {
    if (!this.pool) return;
    this.barBuffer.push(...bars);
    if (this.barBuffer.length >= MAX_BUFFER) void this.flushBars();
  }

  private async flushBars(): Promise<void> {
    if (!this.pool || this.barBuffer.length === 0) return;
    const batch = this.barBuffer;
    this.barBuffer = [];
    try {
      const days = new Set(batch.map((b) => Math.floor(b.ts / 86_400_000)));
      for (const d of days) await ensureDayPartition(this.pool, "bar_1s", d * 86_400_000);

      const cols = 15;
      const values: unknown[] = [];
      const rows = batch.map((b, i) => {
        values.push(
          b.instrumentKey, b.ts, b.o, b.h, b.l, b.c, b.vol, b.oiDelta,
          b.oi ?? null, null, null, b.iv ?? null, b.bidAskImbalance ?? null,
          b.spreadPct ?? null, b.gap ?? false,
        );
        const base = i * cols;
        return `(${Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(",")})`;
      });
      await this.pool.query(
        `INSERT INTO bar_1s (instrument_key, ts, o, h, l, c, vol, oi_delta, oi,
           bid, ask, iv, bid_ask_imbalance, spread_pct, gap)
         VALUES ${rows.join(",")} ON CONFLICT DO NOTHING`,
        values,
      );
      this.barsWritten += batch.length;
    } catch (err) {
      this.fail(err);
    }
  }

  private async saveEvent(e: MomentumEvent): Promise<void> {
    if (!this.pool) return;
    const meta = this.registry.get(e.instrumentKey);
    const underlying = meta?.kind === "option" ? meta.underlying : meta?.underlying;
    await this.pool.query(
      `INSERT INTO momentum_event
         (id, ts, instrument_key, underlying, direction, score, classification,
          evidence, episode_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        e.id, e.ts, e.instrumentKey, underlying ?? null, e.direction, e.score,
        e.classification,
        JSON.stringify({ components: e.components, underlyingConfirmation: e.underlyingConfirmation }),
        e.episodeId,
      ],
    );
    await this.pool.query(
      `INSERT INTO session_stats (session_date, instrument_key, event_count, max_score)
       VALUES (to_timestamp($1 / 1000.0)::date, $2, 1, $3)
       ON CONFLICT (session_date, instrument_key)
       DO UPDATE SET event_count = session_stats.event_count + 1,
                     max_score  = GREATEST(session_stats.max_score, EXCLUDED.max_score)`,
      [e.ts, e.instrumentKey, e.score],
    );
  }

  private async saveLifecycle(t: LifecycleTransition): Promise<void> {
    if (!this.pool) return;
    await this.upsertEpisode(t.episode);
    if (t.type === LifecycleEventType.MOMENTUM_FADING) {
      // §6 momentum_event.decayed_at — the moment the dying signal fired
      await this.pool.query(
        `UPDATE momentum_event SET decayed_at = $1
         WHERE episode_id = $2 AND decayed_at IS NULL`,
        [t.ts, t.episode.id],
      );
    }
  }

  async upsertEpisode(ep: Episode, table = "momentum_episode"): Promise<void> {
    if (!this.pool) return;
    const meta = this.registry.get(ep.instrumentKey);
    await this.pool.query(
      `INSERT INTO ${table}
         (id, instrument_key, underlying, direction, opened_at, closed_at, state,
          peak_score, premium_extreme, ignition, decay_evidence, giveback_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         closed_at = EXCLUDED.closed_at, state = EXCLUDED.state,
         peak_score = EXCLUDED.peak_score, premium_extreme = EXCLUDED.premium_extreme,
         decay_evidence = EXCLUDED.decay_evidence, giveback_pct = EXCLUDED.giveback_pct`,
      [
        ep.id, ep.instrumentKey,
        meta?.kind === "option" ? meta.underlying : null,
        ep.direction, ep.openedAt, ep.closedAt ?? null, ep.state,
        ep.peak.score, ep.peak.premiumExtreme,
        JSON.stringify(ep.ignition), JSON.stringify(ep.decayEvidence),
        ep.givebackPct ?? null,
      ],
    );
  }

  private async saveFeedHealth(kind: string, detail?: Record<string, unknown>): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      "INSERT INTO feed_health (ts, kind, detail) VALUES ($1, $2, $3)",
      [Date.now(), kind, detail ? JSON.stringify(detail) : null],
    );
  }

  private async retention(): Promise<void> {
    if (!this.pool) return;
    try {
      const dropped = await dropOldDayPartitions(this.pool, "bar_1s", RETENTION_DAYS);
      if (dropped.length) this.log.info({ dropped }, "retention dropped partitions");
    } catch (err) {
      this.fail(err);
    }
  }

  /** §12.3: cache the resolved option universe */
  async saveUniverse(): Promise<void> {
    if (!this.pool) return;
    const rows = [...this.registry.all()].flatMap(([key, m]) =>
      m.kind === "option" ? [[key, m.underlying, m.strike, m.side, m.expiry, m.lotSize ?? null]] : [],
    );
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO instrument_universe
           (instrument_key, underlying, strike, side, expiry, lot_size, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (instrument_key) DO UPDATE SET resolved_at = EXCLUDED.resolved_at`,
        [...r, Date.now()],
      );
    }
  }
}
