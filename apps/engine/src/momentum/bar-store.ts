import type { Bar } from "@momentum-scan/shared";
import type Redis from "ioredis";
import type { BaselineSnapshot } from "./baselines";

/**
 * Hot rolling-window storage (SPEC §4): `win:{key}:1s` keeps the last N
 * one-second bars, `baseline:{key}` the current Welford snapshot. All keys
 * expire 1 hour past market close.
 */
export interface BarStore {
  save(
    instrumentKey: string,
    bars: Bar[],
    baseline: BaselineSnapshot,
    ttlSec: number,
  ): Promise<void>;
}

export const BAR_STORE = Symbol("BAR_STORE");

export class RedisBarStore implements BarStore {
  constructor(
    private readonly redis: Redis,
    private readonly windowSize: number,
  ) {}

  async save(
    instrumentKey: string,
    bars: Bar[],
    baseline: BaselineSnapshot,
    ttlSec: number,
  ): Promise<void> {
    if (bars.length === 0) return;
    const winKey = `win:${instrumentKey}:1s`;
    const baseKey = `baseline:${instrumentKey}`;
    const pipe = this.redis.pipeline();
    pipe.rpush(winKey, ...bars.map((b) => JSON.stringify(b)));
    pipe.ltrim(winKey, -this.windowSize, -1);
    pipe.expire(winKey, ttlSec);
    pipe.hset(baseKey, {
      volMean: baseline.volMean,
      volStd: baseline.volStd,
      absRetMean: baseline.absRetMean,
      absRetStd: baseline.absRetStd,
      samples: baseline.samples,
      updatedAt: Date.now(),
    });
    pipe.expire(baseKey, ttlSec);
    await pipe.exec();
  }
}

/** For replay summaries and tests — keeps everything in memory. */
export class InMemoryBarStore implements BarStore {
  readonly windows = new Map<string, Bar[]>();
  readonly baselines = new Map<string, BaselineSnapshot>();

  constructor(private readonly windowSize: number) {}

  async save(
    instrumentKey: string,
    bars: Bar[],
    baseline: BaselineSnapshot,
  ): Promise<void> {
    const win = this.windows.get(instrumentKey) ?? [];
    win.push(...bars);
    this.windows.set(instrumentKey, win.slice(-this.windowSize));
    this.baselines.set(instrumentKey, baseline);
  }
}
