import { Injectable } from "@nestjs/common";

/**
 * Metadata the momentum engine needs per subscribed instrument. Populated by
 * UniverseService from the instruments master (SPEC §12.3); index keys are
 * registered from config at startup. Replay/tests register entries manually.
 */
export interface OptionMeta {
  kind: "option";
  side: 1 | -1; // CE +1 / PE −1
  underlyingKey: string; // index instrument key for §5.6 confirmation
  underlying: string; // NIFTY / BANKNIFTY
  strike: number;
  expiry: string; // YYYY-MM-DD
  lotSize?: number;
}

export interface IndexMeta {
  kind: "index";
  underlying: string;
}

export type InstrumentMeta = OptionMeta | IndexMeta;

@Injectable()
export class InstrumentRegistry {
  private readonly map = new Map<string, InstrumentMeta>();

  registerIndex(key: string, underlying: string): void {
    this.map.set(key, { kind: "index", underlying });
  }

  registerOption(key: string, meta: Omit<OptionMeta, "kind">): void {
    this.map.set(key, { kind: "option", ...meta });
  }

  get(key: string): InstrumentMeta | undefined {
    return this.map.get(key);
  }

  optionKeys(): string[] {
    return [...this.map.entries()]
      .filter(([, m]) => m.kind === "option")
      .map(([k]) => k);
  }

  clearOptions(): void {
    for (const [k, m] of this.map) if (m.kind === "option") this.map.delete(k);
  }

  all(): Map<string, InstrumentMeta> {
    return new Map(this.map);
  }
}
