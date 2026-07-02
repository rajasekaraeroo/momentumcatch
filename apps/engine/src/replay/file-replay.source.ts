import fs from "node:fs";
import readline from "node:readline";
import type { Tick, TickSource } from "@momentum-scan/shared";

/**
 * Replays recorded NDJSON ticks through the same pipeline as the live feed
 * (SPEC §8) — the feed handler swapped for a file reader behind `TickSource`.
 *
 * `speed` is a wall-clock multiplier (10 = 10x faster than recorded);
 * `Infinity` (default in tests) replays with no delays, deterministically.
 */
export class FileReplaySource implements TickSource {
  private stopped = false;

  constructor(
    private readonly file: string,
    private readonly speed: number = Infinity,
  ) {}

  async start(onTick: (t: Tick) => void): Promise<void> {
    this.stopped = false;
    const rl = readline.createInterface({
      input: fs.createReadStream(this.file, "utf8"),
      crlfDelay: Infinity,
    });
    let prevTs: number | null = null;
    for await (const line of rl) {
      if (this.stopped) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tick = JSON.parse(trimmed) as Tick;
      if (
        prevTs !== null &&
        Number.isFinite(this.speed) &&
        this.speed > 0 &&
        tick.ts > prevTs
      ) {
        await sleep((tick.ts - prevTs) / this.speed);
      }
      prevTs = Math.max(prevTs ?? tick.ts, tick.ts);
      onTick(tick);
    }
    rl.close();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
