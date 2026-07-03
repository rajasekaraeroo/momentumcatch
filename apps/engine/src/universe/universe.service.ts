import { Inject, Injectable } from "@nestjs/common";
import { gunzipSync } from "node:zlib";
import { AppConfigService } from "../config/config.service";
import { parseHhMm, toIst } from "../feed/market-hours";
import { createLogger } from "../logger";
import { InstrumentRegistry } from "./instrument-registry";
import {
  needsRecenter,
  parseMasterRow,
  selectUniverse,
  subscriptionDiff,
  type MasterOption,
} from "./universe-select";

/**
 * Per-exchange instruments master (SPEC §12.3, §12.8b). NIFTY/BANKNIFTY
 * options live in the NSE dump (segment NSE_FO); SENSEX options live in the
 * BSE dump (segment BSE_FO). We download only the exchanges the configured
 * universe actually uses and merge the parsed rows.
 */
const EXCHANGE_MASTERS: Record<string, { url: string; segment: string }> = {
  NSE: {
    url: "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",
    segment: "NSE_FO",
  },
  BSE: {
    url: "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz",
    segment: "BSE_FO",
  },
};

export interface UniverseState {
  underlying: string;
  expiry: string;
  atm: number;
  optionKeys: string[];
}

/**
 * Resolves the option universe from the Upstox instruments master
 * (SPEC §12.3): downloads NSE.json.gz daily/on demand, selects nearest-weekly
 * ATM ± N per underlying from the live index spot, registers metadata for
 * the momentum engine, and computes sub/unsub diffs for intraday
 * re-centering (§2). The feed calls `onIndexTick` with each index print.
 */
@Injectable()
export class UniverseService {
  private readonly log = createLogger("universe");
  private master: MasterOption[] | null = null;
  private masterFetchedAt = 0;
  private fetchFailedLogged = false;
  private readonly states = new Map<string, UniverseState>(); // by symbol
  private lastRecenterCheck = 0;

  /** wired by FeedService so universe changes reach the socket */
  onSubscriptionDiff:
    | ((add: string[], remove: string[]) => void)
    | null = null;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(InstrumentRegistry) readonly registry: InstrumentRegistry,
  ) {
    for (const u of config.universe.underlyings) {
      registry.registerIndex(u.indexInstrumentKey, u.symbol);
    }
    // test-only synthetic registrations (schema.ts SYNTH_OPTION_KEYS)
    for (const spec of config.env.SYNTH_OPTION_KEYS.split(",").filter(Boolean)) {
      const [key, side, underlyingKey] = spec.split("=");
      if (!key || !side || !underlyingKey) continue;
      registry.registerIndex(underlyingKey, "SYNTH");
      registry.registerOption(key, {
        side: side === "PE" ? -1 : 1,
        underlyingKey,
        underlying: "SYNTH",
        strike: 0,
        expiry: "2099-01-01",
      });
      this.log.warn({ key }, "synthetic option registered (test-only)");
    }
  }

  /** current option keys across all underlyings (for resubscribe-on-reconnect) */
  optionKeys(): string[] {
    return [...this.states.values()].flatMap((s) => s.optionKeys);
  }

  states_(): UniverseState[] {
    return [...this.states.values()];
  }

  /**
   * Called on every index tick. Resolves the universe on the first spot
   * print and re-centers (throttled to 1/min) when the spot drifts (§2).
   */
  async onIndexTick(indexKey: string, spot: number, nowMs: number): Promise<void> {
    if (this.config.env.FEED_KEYS) return; // manual key override → no universe
    const underlying = this.config.universe.underlyings.find(
      (u) => u.indexInstrumentKey === indexKey,
    );
    if (!underlying) return;

    const state = this.states.get(underlying.symbol);
    if (state) {
      if (nowMs - this.lastRecenterCheck < 60_000) return;
      this.lastRecenterCheck = nowMs;
      if (
        !needsRecenter(
          spot,
          state.atm,
          underlying.strikeStep,
          this.config.universe.recentering.driftStrikesThreshold,
        )
      ) {
        return;
      }
      this.log.info(
        { underlying: underlying.symbol, spot, atm: state.atm },
        "spot drift beyond threshold — re-centering universe",
      );
    }
    await this.resolve(underlying.symbol, spot, nowMs);
  }

  private async resolve(symbol: string, spot: number, nowMs: number): Promise<void> {
    const master = await this.loadMaster(nowMs);
    if (!master) return;
    const underlying = this.config.universe.underlyings.find((u) => u.symbol === symbol);
    if (!underlying) return;

    const ist = toIst(nowMs);
    const pastRollCutoff =
      ist.minutesIst >= parseHhMm(this.config.universe.expiry.rollCutoffIst);
    const selection = selectUniverse(master, {
      underlyingSymbol: symbol,
      spot,
      strikeStep: underlying.strikeStep,
      atmRange: underlying.atmRange,
      todayIst: ist.dateIst,
      pastRollCutoff,
    });
    if (!selection || selection.options.length === 0) {
      this.log.warn({ symbol }, "no matching contracts in instruments master");
      return;
    }

    const prevKeys = this.states.get(symbol)?.optionKeys ?? [];
    const nextKeys = selection.options.map((o) => o.instrumentKey);
    const diff = subscriptionDiff(prevKeys, nextKeys);

    for (const o of selection.options) {
      this.registry.registerOption(o.instrumentKey, {
        side: o.side,
        underlyingKey: underlying.indexInstrumentKey,
        underlying: symbol,
        strike: o.strike,
        expiry: o.expiry,
        lotSize: o.lotSize,
      });
    }
    this.states.set(symbol, {
      underlying: symbol,
      expiry: selection.expiry,
      atm: selection.atm,
      optionKeys: nextKeys,
    });
    this.log.info(
      {
        symbol,
        expiry: selection.expiry,
        atm: selection.atm,
        contracts: nextKeys.length,
        add: diff.add.length,
        remove: diff.remove.length,
      },
      "universe resolved",
    );
    if (diff.add.length || diff.remove.length) {
      this.onSubscriptionDiff?.(diff.add, diff.remove);
    }
  }

  /** distinct exchanges the configured universe actually needs (NSE, BSE) */
  private configuredExchanges(): string[] {
    const set = new Set<string>();
    for (const u of this.config.universe.underlyings) set.add(u.exchange);
    return [...set];
  }

  private async loadMaster(nowMs: number): Promise<MasterOption[] | null> {
    // refresh at most every 6h; §2 asks for a daily 08:45 pull which the
    // first index tick of the morning triggers naturally
    if (this.master && nowMs - this.masterFetchedAt < 6 * 3600_000) {
      return this.master;
    }
    try {
      const merged: MasterOption[] = [];
      for (const exchange of this.configuredExchanges()) {
        const source = EXCHANGE_MASTERS[exchange];
        if (!source) {
          this.log.warn({ exchange }, "no instruments-master URL for exchange — skipped");
          continue;
        }
        const res = await fetch(source.url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${exchange} master`);
        const gz = Buffer.from(await res.arrayBuffer());
        const rows: unknown[] = JSON.parse(gunzipSync(gz).toString("utf8"));
        const parsed = rows
          .map((r) => parseMasterRow(r, source.segment))
          .filter((r): r is MasterOption => r !== null);
        this.log.info(
          { exchange, segment: source.segment, contracts: parsed.length },
          "exchange instruments master parsed",
        );
        merged.push(...parsed);
      }
      if (merged.length === 0) {
        throw new Error(
          "masters parsed but yielded 0 option contracts — schema drift?",
        );
      }
      this.master = merged;
      this.masterFetchedAt = nowMs;
      this.fetchFailedLogged = false;
      this.log.info({ contracts: merged.length }, "instruments master loaded");
      return merged;
    } catch (err) {
      if (!this.fetchFailedLogged) {
        this.log.error(
          { err: (err as Error).message },
          "instruments master download failed — engine continues with indices only",
        );
        this.fetchFailedLogged = true;
      }
      return this.master;
    }
  }
}
