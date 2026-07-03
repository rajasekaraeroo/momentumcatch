import type { DepthLevel } from "../types";

/**
 * Order-book imbalance variants (SPEC §5.5, §12.8). Pure.
 *
 * - `simpleImbalance`: the D5 behavior — unweighted quantity imbalance.
 * - `weightedImbalance`: the D30 focus-pool variant — level i is weighted
 *   w_i = exp(−λ·i), so size parked deep in the book counts far less than
 *   size at the touch.
 *
 * Both guard the empty/one-sided book: imbalance 0 with lowQuality=true so
 * consumers can treat the reading as "no information" rather than neutral
 * conviction.
 */

export interface ImbalanceResult {
  /** (weighted) (Σbid − Σask) / (Σbid + Σask), ∈ [−1, +1] */
  imbalance: number;
  /** true when the book was empty/one-sided — reading carries no signal */
  lowQuality: boolean;
}

export interface BookDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

/** current D5 behavior: plain quantity imbalance over the visible book */
export function simpleImbalance(depth: BookDepth): ImbalanceResult {
  let bid = 0;
  let ask = 0;
  for (const l of depth.bids) bid += l.qty;
  for (const l of depth.asks) ask += l.qty;
  const total = bid + ask;
  if (total === 0) return { imbalance: 0, lowQuality: true };
  return { imbalance: (bid - ask) / total, lowQuality: bid === 0 || ask === 0 };
}

/** §12.8 distance-weighted imbalance: w_i = exp(−lambda·i), level 0 = touch */
export function weightedImbalance(depth: BookDepth, lambda: number): ImbalanceResult {
  let bid = 0;
  let ask = 0;
  depth.bids.forEach((l, i) => (bid += Math.exp(-lambda * i) * l.qty));
  depth.asks.forEach((l, i) => (ask += Math.exp(-lambda * i) * l.qty));
  const total = bid + ask;
  if (total === 0) return { imbalance: 0, lowQuality: true };
  return { imbalance: (bid - ask) / total, lowQuality: bid === 0 || ask === 0 };
}
