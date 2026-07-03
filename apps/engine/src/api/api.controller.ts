import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { Bar } from "@momentum-scan/shared";
import { PG } from "../db/db.module";
import { FeedService } from "../feed/feed.service";
import { MomentumService } from "../momentum/momentum.service";
import { REDIS } from "../redis/redis.module";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { UniverseService } from "../universe/universe.service";

/** REST API (SPEC §7): /universe, /events, /instrument/:key/bars. */
@Controller()
export class ApiController {
  constructor(
    @Inject(InstrumentRegistry) private readonly registry: InstrumentRegistry,
    @Inject(UniverseService) private readonly universe: UniverseService,
    @Inject(FeedService) private readonly feed: FeedService,
    @Inject(MomentumService) private readonly momentum: MomentumService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG) private readonly pool: Pool | null,
  ) {}

  @Get("universe")
  universeState(): Record<string, unknown> {
    const instruments = [...this.registry.all()].map(([key, meta]) => ({
      instrumentKey: key,
      ...meta,
    }));
    return {
      feed: this.feed.getStatus(),
      selections: this.universe.states_(),
      instruments,
    };
  }

  @Get("events")
  async events(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("underlying") underlying?: string,
  ): Promise<unknown[]> {
    if (!this.pool) return [];
    const conds: string[] = [];
    const params: unknown[] = [];
    if (from) {
      params.push(Number(from));
      conds.push(`ts >= $${params.length}`);
    }
    if (to) {
      params.push(Number(to));
      conds.push(`ts <= $${params.length}`);
    }
    if (underlying) {
      params.push(underlying);
      conds.push(`underlying = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(
      `SELECT * FROM momentum_event ${where} ORDER BY ts DESC LIMIT 500`,
      params,
    );
    return res.rows;
  }

  @Get("instrument/:key/bars")
  async bars(
    @Param("key") key: string,
    @Query("window") window?: string,
  ): Promise<Bar[]> {
    const windowSec = Math.min(Number(window ?? 300) || 300, 86_400);
    // hot path: the Redis rolling window covers the trailing 300s
    if (windowSec <= 300) {
      const raw = await this.redis
        .lrange(`win:${key}:1s`, -windowSec, -1)
        .catch(() => [] as string[]);
      return raw.map((j) => JSON.parse(j) as Bar);
    }
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT instrument_key, ts, o, h, l, c, vol, oi_delta, oi, iv,
              bid_ask_imbalance, spread_pct, gap
       FROM bar_1s WHERE instrument_key = $1 AND ts >= $2 ORDER BY ts`,
      [key, Date.now() - windowSec * 1000],
    );
    return res.rows.map((r) => ({
      instrumentKey: r.instrument_key,
      ts: Number(r.ts),
      o: r.o, h: r.h, l: r.l, c: r.c,
      vol: r.vol,
      oiDelta: r.oi_delta,
      oi: r.oi ?? undefined,
      vwapNum: 0,
      vwapDen: 0,
      iv: r.iv ?? undefined,
      bidAskImbalance: r.bid_ask_imbalance ?? undefined,
      spreadPct: r.spread_pct ?? undefined,
      gap: r.gap || undefined,
    }));
  }

  @Get("snapshots")
  snapshots(): unknown[] {
    return this.momentum.allSnapshots();
  }
}
