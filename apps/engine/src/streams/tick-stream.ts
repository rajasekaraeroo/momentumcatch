import type { Tick } from "@momentum-scan/shared";
import type Redis from "ioredis";

/**
 * Transport between the feed handler and the momentum engine (SPEC §1):
 * Redis Streams `ticks:{instrumentKey}` in production so the two sides can
 * later run as separate processes; an in-memory implementation for tests
 * and replay. A `gap` entry marks a feed outage (SPEC §9) so consumers
 * restart their baselines instead of z-scoring across it.
 */

export type StreamEntry =
  | { kind: "tick"; tick: Tick }
  | { kind: "gap"; ts: number };

export interface TickStreamBus {
  publishTick(tick: Tick): Promise<void>;
  publishGap(instrumentKeys: string[], ts: number): Promise<void>;
  /** read new entries for the consumer group; at-least-once semantics */
  consume(instrumentKeys: string[], maxPerStream: number): Promise<Map<string, StreamEntry[]>>;
}

export const TICK_STREAM = Symbol("TICK_STREAM");

const STREAM_PREFIX = "ticks:";
const GROUP = "agg";
const CONSUMER = "agg-1";
const STREAM_MAXLEN = 10_000;

export class RedisTickStream implements TickStreamBus {
  private readonly groupsEnsured = new Set<string>();

  constructor(private readonly redis: Redis) {}

  private key(instrumentKey: string): string {
    return STREAM_PREFIX + instrumentKey;
  }

  async publishTick(tick: Tick): Promise<void> {
    await this.redis.xadd(
      this.key(tick.instrumentKey),
      "MAXLEN",
      "~",
      STREAM_MAXLEN,
      "*",
      "kind",
      "tick",
      "data",
      JSON.stringify(tick),
    );
  }

  async publishGap(instrumentKeys: string[], ts: number): Promise<void> {
    await Promise.all(
      instrumentKeys.map((k) =>
        this.redis.xadd(
          this.key(k),
          "MAXLEN",
          "~",
          STREAM_MAXLEN,
          "*",
          "kind",
          "gap",
          "data",
          String(ts),
        ),
      ),
    );
  }

  private async ensureGroup(streamKey: string): Promise<void> {
    if (this.groupsEnsured.has(streamKey)) return;
    try {
      // $ = only entries newer than group creation; MKSTREAM allows pre-creation
      await this.redis.xgroup("CREATE", streamKey, GROUP, "$", "MKSTREAM");
    } catch (err) {
      if (!(err as Error).message.includes("BUSYGROUP")) throw err;
    }
    this.groupsEnsured.add(streamKey);
  }

  async consume(
    instrumentKeys: string[],
    maxPerStream: number,
  ): Promise<Map<string, StreamEntry[]>> {
    const out = new Map<string, StreamEntry[]>();
    if (instrumentKeys.length === 0) return out;
    for (const k of instrumentKeys) await this.ensureGroup(this.key(k));

    const streamKeys = instrumentKeys.map((k) => this.key(k));
    const res = (await this.redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      maxPerStream,
      "STREAMS",
      ...streamKeys,
      ...streamKeys.map(() => ">"),
    )) as [string, [string, string[]][]][] | null;
    if (!res) return out;

    for (const [streamKey, entries] of res) {
      const instrumentKey = streamKey.slice(STREAM_PREFIX.length);
      const parsed: StreamEntry[] = [];
      const ids: string[] = [];
      for (const [id, fields] of entries) {
        ids.push(id);
        const rec: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          rec[fields[i] as string] = fields[i + 1] as string;
        }
        if (rec.kind === "gap") {
          parsed.push({ kind: "gap", ts: Number(rec.data) });
        } else if (rec.kind === "tick" && rec.data) {
          parsed.push({ kind: "tick", tick: JSON.parse(rec.data) as Tick });
        }
      }
      if (ids.length) await this.redis.xack(streamKey, GROUP, ...ids);
      out.set(instrumentKey, parsed);
    }
    return out;
  }
}

/** Deterministic in-process bus for unit tests and replay mode. */
export class InMemoryTickStream implements TickStreamBus {
  private readonly queues = new Map<string, StreamEntry[]>();

  private queue(key: string): StreamEntry[] {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    return q;
  }

  async publishTick(tick: Tick): Promise<void> {
    this.queue(tick.instrumentKey).push({ kind: "tick", tick });
  }

  async publishGap(instrumentKeys: string[], ts: number): Promise<void> {
    for (const k of instrumentKeys) this.queue(k).push({ kind: "gap", ts });
  }

  async consume(
    instrumentKeys: string[],
    maxPerStream: number,
  ): Promise<Map<string, StreamEntry[]>> {
    const out = new Map<string, StreamEntry[]>();
    for (const k of instrumentKeys) {
      const q = this.queue(k);
      if (q.length) out.set(k, q.splice(0, maxPerStream));
    }
    return out;
  }
}
