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

const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

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

  private async loadMaster(nowMs: number): Promise<MasterOption[] | null> {
    // refresh at most every 6h; §2 asks for a daily 08:45 pull which the
    // first index tick of the morning triggers naturally
    if (this.master && nowMs - this.masterFetchedAt < 6 * 3600_000) {
      return this.master;
    }
    try {
      const res = await fetch(MASTER_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gz = Buffer.from(await res.arrayBuffer());
      const rows: unknown[] = JSON.parse(gunzipSync(gz).toString("utf8"));
      const parsed = rows
        .map(parseMasterRow)
        .filter((r): r is MasterOption => r !== null);
      if (parsed.length === 0) {
        throw new Error("master parsed but yielded 0 NSE_FO options — schema drift?");
      }
      this.master = parsed;
      this.masterFetchedAt = nowMs;
      this.fetchFailedLogged = false;
      this.log.info({ contracts: parsed.length }, "instruments master loaded");
      return parsed;
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
