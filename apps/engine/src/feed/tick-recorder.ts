import fs from "node:fs";
import path from "node:path";
import type { Tick } from "@momentum-scan/shared";
import { toIst } from "./market-hours";

/**
 * Appends raw normalized ticks to data/ticks/YYYY-MM-DD.ndjson when
 * RECORD_TICKS=true (SPEC §6) — the input for replay/Track B validation (§8).
 */
export class TickRecorder {
  private stream: fs.WriteStream | null = null;
  private streamDate: string | null = null;

  constructor(private readonly dataDir: string) {}

  record(tick: Tick): void {
    const date = toIst(tick.ts).dateIst;
    if (!this.stream || this.streamDate !== date) {
      this.stream?.end();
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.stream = fs.createWriteStream(
        path.join(this.dataDir, `${date}.ndjson`),
        { flags: "a" },
      );
      this.streamDate = date;
    }
    this.stream.write(JSON.stringify(tick) + "\n");
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
    this.streamDate = null;
  }
}
