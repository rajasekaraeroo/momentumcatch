import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import { hotKeyTtlSec } from "../feed/market-hours";
import { createLogger } from "../logger";
import { TICK_STREAM, type TickStreamBus } from "../streams/tick-stream";
import { PersistenceService } from "../persistence/persistence.service";
import { InstrumentRegistry } from "../universe/instrument-registry";
import { Aggregator } from "./aggregator";
import { BAR_STORE, type BarStore } from "./bar-store";
import { MomentumService } from "./momentum.service";

/**
 * The 1s aggregation job (SPEC §4): every second, pull new entries from the
 * tick streams (consumer group), close aged bars, update baselines, persist
 * the rolling window + baseline snapshot to Redis with the close+1h TTL.
 *
 * Buckets are keyed by exchange ltt; we close through wallclock-2s so
 * slightly late ticks still land in their bucket.
 */

const JOB_INTERVAL_MS = 1_000;
const CLOSE_LAG_SEC = 2;
const MAX_ENTRIES_PER_STREAM = 2_000;

export interface AggregationStatus {
  barsClosedTotal: number;
  gapsTotal: number;
  activeInstruments: number;
  lastRunAt: number | null;
}

@Injectable()
export class AggregationService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = createLogger("agg");
  private readonly barLog = createLogger("bar");
  private readonly aggregator: Aggregator;
  private readonly instrumentKeys: string[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: number | null = null;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(TICK_STREAM) private readonly bus: TickStreamBus,
    @Inject(BAR_STORE) private readonly store: BarStore,
    @Inject(MomentumService) private readonly momentum: MomentumService,
    @Inject(InstrumentRegistry) private readonly registry: InstrumentRegistry,
    @Inject(PersistenceService) private readonly persistence: PersistenceService,
  ) {
    this.aggregator = new Aggregator({
      baselineWindow: config.momentum.windows.baselineSec,
      openExclusionSec: config.momentum.windows.openExclusionSec,
    });
    this.instrumentKeys = config.env.FEED_KEYS
      ? config.env.FEED_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
      : config.universe.underlyings.map((u) => u.indexInstrumentKey);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), JOB_INTERVAL_MS);
    this.log.info(
      { instruments: this.instrumentKeys.length },
      "1s aggregation job started",
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getStatus(): AggregationStatus {
    return {
      barsClosedTotal: this.aggregator.barsClosedTotal,
      gapsTotal: this.aggregator.gapsTotal,
      activeInstruments: this.aggregator.activeInstruments().length,
      lastRunAt: this.lastRunAt,
    };
  }

  private async runOnce(): Promise<void> {
    if (this.running) return; // don't overlap slow runs
    this.running = true;
    try {
      const now = Date.now();
      this.lastRunAt = now;
      const throughSec = Math.floor(now / 1000) - CLOSE_LAG_SEC;
      const ttl = hotKeyTtlSec(now, this.config.universe.schedule.disconnectIst);
      // static index/override keys + whatever the universe resolved intraday
      const consumeKeys = [
        ...new Set([...this.instrumentKeys, ...this.registry.optionKeys()]),
      ];
      const batches = await this.bus.consume(consumeKeys, MAX_ENTRIES_PER_STREAM);

      // instruments with fresh entries + previously active ones needing flush
      const keys = new Set([
        ...batches.keys(),
        ...this.aggregator.activeInstruments(),
      ]);
      for (const key of keys) {
        const bars = [
          ...this.aggregator.handleEntries(key, batches.get(key) ?? []),
          ...this.aggregator.flush(key, throughSec),
        ];
        if (bars.length === 0) continue;
        for (const bar of bars) {
          this.barLog.info(
            {
              key,
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
        }
        const baseline = this.aggregator.baselineSnapshot(key);
        await this.store.save(key, bars, baseline, ttl);
        // hand the closed bars to the scoring engine (SPEC §5)
        this.momentum.onBars(key, bars, baseline);
        this.persistence.bufferBars(bars);
      }
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "aggregation run failed");
    } finally {
      this.running = false;
    }
  }
}
