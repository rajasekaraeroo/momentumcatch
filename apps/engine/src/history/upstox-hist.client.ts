import type { Bar } from "@momentum-scan/shared";
import { createLogger } from "../logger";

/**
 * Upstox Expired Instruments + Historical Candle client (SPEC §13.1).
 * Requires Upstox Plus. Rate-limit-aware queue (configurable req/s) with
 * exponential backoff on 429. Response field names follow the documented
 * shapes — VERIFY against live responses at first real run.
 */

const API = "https://api.upstox.com";

export interface ExpiredContract {
  expiredInstrumentKey: string; // NSE_FO|{token}|{DD-MM-YYYY}
  strike: number;
  side: 1 | -1;
  expiry: string; // YYYY-MM-DD
}

export class RateLimiter {
  private nextSlot = 0;
  constructor(private readonly perSecond: number) {}
  async wait(now = Date.now()): Promise<number> {
    const interval = 1000 / this.perSecond;
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + interval;
    const delay = slot - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return delay;
  }
}

export class UpstoxHistClient {
  private readonly log = createLogger("hist-api");
  private readonly limiter: RateLimiter;

  constructor(
    private readonly token: string,
    requestsPerSecond: number,
  ) {
    this.limiter = new RateLimiter(requestsPerSecond);
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    await this.limiter.wait();
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    if (res.status === 429 && attempt < 6) {
      const backoff = Math.min(1000 * 2 ** attempt, 30_000);
      this.log.warn({ path, backoff }, "429 — backing off");
      await new Promise((r) => setTimeout(r, backoff));
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T };
    return (body.data ?? (body as unknown)) as T;
  }

  async expiries(instrumentKey: string): Promise<string[]> {
    return this.get<string[]>(
      `/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(instrumentKey)}`,
    );
  }

  async optionContracts(instrumentKey: string, expiryDate: string): Promise<ExpiredContract[]> {
    /* eslint-disable @typescript-eslint/no-explicit-any -- external API rows,
       normalized immediately with guards */
    const rows = await this.get<any[]>(
      `/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(
        instrumentKey,
      )}&expiry_date=${expiryDate}`,
    );
    return (rows ?? [])
      .map((r: any): ExpiredContract | null => {
        const key = r?.expired_instrument_key ?? r?.instrument_key;
        const type = r?.instrument_type ?? r?.option_type;
        const strike = Number(r?.strike_price ?? r?.strike);
        if (!key || (type !== "CE" && type !== "PE") || !Number.isFinite(strike)) return null;
        return {
          expiredInstrumentKey: key,
          strike,
          side: type === "CE" ? 1 : -1,
          expiry: expiryDate,
        };
      })
      .filter((r): r is ExpiredContract => r !== null);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /** candles arrive newest-first as [ts, o, h, l, c, vol, oi] arrays */
  async expiredCandles1m(expiredKey: string, from: string, to: string): Promise<Bar[]> {
    const rows = await this.get<{ candles?: unknown[][] }>(
      `/v2/expired-instruments/historical-candle/${encodeURIComponent(
        expiredKey,
      )}/1minute/${to}/${from}`,
    );
    return this.parseCandles(expiredKey, rows?.candles ?? []);
  }

  /** index 1m via Historical Candle V3 (verify availability window, §13.1) */
  async indexCandles1m(instrumentKey: string, from: string, to: string): Promise<Bar[]> {
    const rows = await this.get<{ candles?: unknown[][] }>(
      `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`,
    );
    return this.parseCandles(instrumentKey, rows?.candles ?? []);
  }

  private parseCandles(key: string, rows: unknown[][]): Bar[] {
    const bars: Bar[] = [];
    for (const row of rows) {
      const [ts, o, h, l, c, vol, oi] = row as [string | number, number, number, number, number, number, number?];
      const t = typeof ts === "number" ? ts : Date.parse(ts);
      if (!Number.isFinite(t)) continue;
      bars.push({
        instrumentKey: key,
        ts: t,
        o, h, l, c,
        vol: vol ?? 0,
        oiDelta: 0,
        oi: oi ?? undefined,
        vwapNum: 0,
        vwapDen: 0,
      });
    }
    // API returns newest-first; the engine wants chronological
    bars.sort((a, b) => a.ts - b.ts);
    // duplicate-timestamp guard (§13.1 data-quality)
    return bars.filter((b, i) => i === 0 || b.ts !== (bars[i - 1] as Bar).ts);
  }
}
