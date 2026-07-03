import type { Bar } from "@momentum-scan/shared";
import type { StreamEntry } from "../streams/tick-stream";
import { BarBuilder } from "./bar-builder";
import { Baselines, type BaselineSnapshot } from "./baselines";

export interface AggregatorConfig {
  baselineWindow: number; // trailing samples (300 live)
  openExclusionSec: number; // SPEC §4 open-poisoning guard
}

/**
 * Per-instrument 1s aggregation + baselines, independent of transport and
 * storage (SPEC §4). The Nest service feeds it from the Redis stream; the
 * replay CLI feeds it directly from a file.
 */
export class Aggregator {
  private readonly builders = new Map<string, BarBuilder>();
  private readonly baselines = new Map<string, Baselines>();
  barsClosedTotal = 0;
  gapsTotal = 0;

  constructor(private readonly cfg: AggregatorConfig) {}

  private builder(key: string): BarBuilder {
    let b = this.builders.get(key);
    if (!b) {
      b = new BarBuilder(key);
      this.builders.set(key, b);
    }
    return b;
  }

  baseline(key: string): Baselines {
    let b = this.baselines.get(key);
    if (!b) {
      b = new Baselines(this.cfg.baselineWindow, this.cfg.openExclusionSec);
      this.baselines.set(key, b);
    }
    return b;
  }

  /** Process stream entries for one instrument; returns bars closed. */
  handleEntries(instrumentKey: string, entries: StreamEntry[]): Bar[] {
    const builder = this.builder(instrumentKey);
    const closed: Bar[] = [];
    for (const entry of entries) {
      if (entry.kind === "gap") {
        builder.markGap();
        this.gapsTotal += 1;
        continue;
      }
      closed.push(...builder.ingest(entry.tick));
    }
    return this.finalize(instrumentKey, closed);
  }

  /** Close buckets that aged out without newer ticks (call each second). */
  flush(instrumentKey: string, throughSec: number): Bar[] {
    return this.finalize(
      instrumentKey,
      this.builder(instrumentKey).flush(throughSec),
    );
  }

  activeInstruments(): string[] {
    return [...this.builders.keys()];
  }

  baselineSnapshot(key: string): BaselineSnapshot {
    return this.baseline(key).snapshot();
  }

  private finalize(instrumentKey: string, bars: Bar[]): Bar[] {
    for (const bar of bars) this.baseline(instrumentKey).update(bar);
    this.barsClosedTotal += bars.length;
    return bars;
  }
}
