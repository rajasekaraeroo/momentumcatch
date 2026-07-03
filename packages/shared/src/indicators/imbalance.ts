import type { Tick } from "../types";

/**
 * Order-book imbalance from top-5 depth (SPEC §5.5):
 *   (Σ bid qty − Σ ask qty) / (Σ bid qty + Σ ask qty)  ∈ [-1, +1]
 * Falls back to best bid/ask quantities when full depth is absent;
 * undefined when the tick carries no quote information at all.
 */
export function depthImbalance(tick: Tick): number | undefined {
  let bid = 0;
  let ask = 0;
  if (tick.depth && (tick.depth.bids.length || tick.depth.asks.length)) {
    for (const l of tick.depth.bids) bid += l.qty;
    for (const l of tick.depth.asks) ask += l.qty;
  } else if (tick.bidQty !== undefined || tick.askQty !== undefined) {
    bid = tick.bidQty ?? 0;
    ask = tick.askQty ?? 0;
  } else {
    return undefined;
  }
  const total = bid + ask;
  if (total === 0) return undefined;
  return (bid - ask) / total;
}
