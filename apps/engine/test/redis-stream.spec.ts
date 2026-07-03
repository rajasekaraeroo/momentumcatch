import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tick } from "@momentum-scan/shared";
import { InMemoryTickStream, RedisTickStream } from "../src/streams/tick-stream";
import { InMemoryBarStore, RedisBarStore } from "../src/momentum/bar-store";

/**
 * Integration test for the Redis Streams transport + hot-window storage
 * (SPEC §1, §4). Runs against a local redis-server on port 6390 (DB 15) and
 * skips automatically when none is reachable, so CI without Redis stays green.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6390/15";
const KEY = "SYNTH_FO|SAMPLE_CE";

const tick = (ts: number, ltp: number): Tick => ({ instrumentKey: KEY, ts, ltp });

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

describe("RedisTickStream against a real redis-server", () => {
  let redis: Redis | null = null;

  beforeAll(async () => {
    if (!(await redisAvailable())) return; // tests below skip themselves
    redis = new Redis(REDIS_URL);
    await redis.flushdb();
  });

  afterAll(() => {
    redis?.disconnect();
  });

  it("round-trips ticks and gap markers through the consumer group", async (ctx) => {
    if (!redis) return ctx.skip();
    const bus = new RedisTickStream(redis);
    // group is created lazily on first consume; entries published after that
    await bus.consume([KEY], 100);
    await bus.publishTick(tick(1_000, 100.5));
    await bus.publishTick(tick(2_000, 101));
    await bus.publishGap([KEY], 3_000);

    const batches = await bus.consume([KEY], 100);
    expect(batches.get(KEY)).toEqual([
      { kind: "tick", tick: tick(1_000, 100.5) },
      { kind: "tick", tick: tick(2_000, 101) },
      { kind: "gap", ts: 3_000 },
    ]);

    // consumed entries are acked — nothing is redelivered
    const again = await bus.consume([KEY], 100);
    expect(again.get(KEY)).toBeUndefined();
  });

  it("stores rolling windows and baselines with a TTL", async (ctx) => {
    if (!redis) return ctx.skip();
    const store = new RedisBarStore(redis, 3);
    const mkBar = (ts: number, c: number) => ({
      instrumentKey: KEY,
      ts,
      o: c,
      h: c,
      l: c,
      c,
      vol: 10,
      oiDelta: 0,
      vwapNum: 0,
      vwapDen: 0,
    });
    await store.save(
      KEY,
      [mkBar(1000, 1), mkBar(2000, 2), mkBar(3000, 3), mkBar(4000, 4)],
      { volMean: 10, volStd: 0, absRetMean: 0, absRetStd: 0, samples: 4 },
      120,
    );
    const win = await redis.lrange(`win:${KEY}:1s`, 0, -1);
    // trimmed to windowSize=3, oldest dropped
    expect(win.map((j) => JSON.parse(j).c)).toEqual([2, 3, 4]);
    expect(await redis.ttl(`win:${KEY}:1s`)).toBeGreaterThan(0);
    expect(await redis.hget(`baseline:${KEY}`, "samples")).toBe("4");
    expect(await redis.ttl(`baseline:${KEY}`)).toBeGreaterThan(0);
  });
});

describe("InMemoryTickStream mirrors the bus contract", () => {
  it("delivers each entry exactly once, per instrument", async () => {
    const bus = new InMemoryTickStream();
    await bus.publishTick(tick(1_000, 100));
    await bus.publishGap([KEY], 2_000);
    const first = await bus.consume([KEY], 10);
    expect(first.get(KEY)).toHaveLength(2);
    const second = await bus.consume([KEY], 10);
    expect(second.get(KEY)).toBeUndefined();
  });
});

describe("InMemoryBarStore", () => {
  it("keeps only the trailing window", async () => {
    const store = new InMemoryBarStore(2);
    const bar = (ts: number) => ({
      instrumentKey: KEY,
      ts,
      o: 1,
      h: 1,
      l: 1,
      c: 1,
      vol: 0,
      oiDelta: 0,
      vwapNum: 0,
      vwapDen: 0,
    });
    await store.save(KEY, [bar(1), bar(2), bar(3)], {
      volMean: 0,
      volStd: 0,
      absRetMean: 0,
      absRetStd: 0,
      samples: 3,
    });
    expect(store.windows.get(KEY)?.map((b) => b.ts)).toEqual([2, 3]);
  });
});
