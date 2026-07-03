import type { DepthLevel, Tick } from "@momentum-scan/shared";

/**
 * Normalizes a decoded MarketDataFeedV3 `FeedResponse` object into `Tick`s
 * (SPEC §3, §12.5).
 *
 * Shapes below follow SPEC §12.5 and the Upstox V3 feed docs. The proto file
 * is the contract (packages/shared/proto/README.md) — VERIFY these field
 * names against a decoded frame from the real feed on the first live run;
 * the normalizer deliberately degrades to `undefined` rather than throwing
 * when an optional field is absent or renamed.
 */

interface DecodedLtpc {
  ltp?: number | string;
  ltt?: number | string;
  ltq?: number | string;
  cp?: number | string;
}

interface DecodedQuote {
  bidQ?: number | string;
  bidP?: number | string;
  askQ?: number | string;
  askP?: number | string;
  // some proto revisions use long-form names
  bidQty?: number | string;
  bidPrice?: number | string;
  askQty?: number | string;
  askPrice?: number | string;
}

interface DecodedGreeks {
  iv?: number | string;
  delta?: number | string;
  theta?: number | string;
  vega?: number | string;
}

interface DecodedMarketFF {
  ltpc?: DecodedLtpc;
  marketLevel?: { bidAskQuote?: DecodedQuote[] };
  optionGreeks?: DecodedGreeks;
  vtt?: number | string;
  oi?: number | string;
  atp?: number | string;
}

interface DecodedIndexFF {
  ltpc?: DecodedLtpc;
}

interface DecodedFeed {
  ltpc?: DecodedLtpc;
  fullFeed?: { marketFF?: DecodedMarketFF; indexFF?: DecodedIndexFF };
  firstLevelWithGreeks?: {
    ltpc?: DecodedLtpc;
    firstDepth?: DecodedQuote;
    optionGreeks?: DecodedGreeks;
    vtt?: number | string;
    oi?: number | string;
  };
}

export interface DecodedFeedResponse {
  type?: string;
  feeds?: Record<string, DecodedFeed>;
  currentTs?: number | string;
  marketInfo?: { segmentStatus?: Record<string, string | number> };
}

function num(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function depthFromQuotes(quotes: DecodedQuote[] | undefined): {
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  best?: { bidPrice?: number; bidQty?: number; askPrice?: number; askQty?: number };
} {
  if (!quotes?.length) return {};
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  // 5 levels in `full` mode, up to 30 in `full_d30` (SPEC §12.8)
  for (const q of quotes.slice(0, 30)) {
    const bp = num(q.bidP ?? q.bidPrice);
    const bq = num(q.bidQ ?? q.bidQty);
    const ap = num(q.askP ?? q.askPrice);
    const aq = num(q.askQ ?? q.askQty);
    if (bp !== undefined && bq !== undefined) bids.push({ price: bp, qty: bq });
    if (ap !== undefined && aq !== undefined) asks.push({ price: ap, qty: aq });
  }
  const b0 = bids[0];
  const a0 = asks[0];
  return {
    depth: bids.length || asks.length ? { bids, asks } : undefined,
    best: {
      bidPrice: b0?.price,
      bidQty: b0?.qty,
      askPrice: a0?.price,
      askQty: a0?.qty,
    },
  };
}

/**
 * Returns normalized ticks; `market_info` frames yield no ticks (they carry
 * segment status, not tick data — the caller records feed health from them).
 */
export function normalizeFeedResponse(
  res: DecodedFeedResponse,
  receiveTsMs: number,
): Tick[] {
  if (res.type === "market_info" || !res.feeds) return [];
  const ticks: Tick[] = [];

  for (const [instrumentKey, feed] of Object.entries(res.feeds)) {
    const marketFF = feed.fullFeed?.marketFF;
    const indexFF = feed.fullFeed?.indexFF;
    const flwg = feed.firstLevelWithGreeks;
    const ltpc = marketFF?.ltpc ?? indexFF?.ltpc ?? flwg?.ltpc ?? feed.ltpc;
    const ltp = num(ltpc?.ltp);
    if (ltp === undefined) continue; // nothing usable in this feed entry

    const quotes = marketFF?.marketLevel?.bidAskQuote
      ?? (flwg?.firstDepth ? [flwg.firstDepth] : undefined);
    const { depth, best } = depthFromQuotes(quotes);
    const greeks = marketFF?.optionGreeks ?? flwg?.optionGreeks;

    ticks.push({
      instrumentKey,
      ts: num(ltpc?.ltt) ?? receiveTsMs,
      ltp,
      ltq: num(ltpc?.ltq),
      volume: num(marketFF?.vtt ?? flwg?.vtt),
      oi: num(marketFF?.oi ?? flwg?.oi),
      bidPrice: best?.bidPrice,
      bidQty: best?.bidQty,
      askPrice: best?.askPrice,
      askQty: best?.askQty,
      depth,
      depthLevels: depth ? Math.max(depth.bids.length, depth.asks.length) : undefined,
      iv: num(greeks?.iv),
      delta: num(greeks?.delta),
      theta: num(greeks?.theta),
      vega: num(greeks?.vega),
    });
  }
  return ticks;
}
