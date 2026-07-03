/**
 * Canonical domain types for MomentumScan (SPEC §3, §5, §14).
 * Both the live engine (1s) and the backtester (1m) use these shapes.
 * All output is DESCRIPTIVE: nothing here may encode a trade recommendation.
 */

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface Tick {
  instrumentKey: string;
  /** exchange last-trade time (ms) if present, else receive time */
  ts: number;
  ltp: number;
  ltq?: number;
  /** cumulative day volume */
  volume?: number;
  oi?: number;
  bidPrice?: number;
  bidQty?: number;
  askPrice?: number;
  askQty?: number;
  /** order book: 5 levels in standard `full` mode, 30 levels when the
   *  instrument is in the D30 focus pool (`full_d30`, SPEC §12.8) */
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  /** number of book levels this tick carries (5 or 30); absent = unknown/5 */
  depthLevels?: number;
  iv?: number;
  delta?: number;
  theta?: number;
  vega?: number;
}

/** One aggregated bar — 1s (live) or 1m (backtest). */
export interface Bar {
  instrumentKey: string;
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** volume traded within this bar (delta, not cumulative) */
  vol: number;
  oiDelta: number;
  oi?: number;
  vwapNum: number;
  vwapDen: number;
  bidAskImbalance?: number;
  /** last observed bid/ask spread within the bar, % of mid (liquidity gate) */
  spreadPct?: number;
  /** last observed implied volatility within the bar (when greeks present) */
  iv?: number;
  /** book depth basis of the imbalance snapshot (5 or 30, SPEC §12.8) —
   *  a change between bars marks a D5↔D30 switch: flow smoothers restart */
  depthLevels?: number;
  /** true if a feed gap spans this bar — baselines must restart (SPEC §9) */
  gap?: boolean;
}

export type Direction = 1 | -1;

export enum SignalClassification {
  DIRECTIONAL_BUILD = "DIRECTIONAL_BUILD",
  DIRECTIONAL_FADE = "DIRECTIONAL_FADE",
  VOL_EVENT = "VOL_EVENT",
  SHORT_COVERING = "SHORT_COVERING",
  LONG_UNWIND = "LONG_UNWIND",
  NOISE = "NOISE",
}

/** Per-component evidence — values + normalized scores, for display/audit. */
export interface ComponentEvidence {
  name: string;
  raw: number;
  normalized: number; // [-1, +1] or [0, 1] depending on component
  available: boolean;
}

export interface MomentumSnapshot {
  instrumentKey: string;
  ts: number;
  score: number; // 0–100
  direction: Direction;
  classification: SignalClassification;
  components: ComponentEvidence[];
  underlyingConfirmation: number; // [0.5, 1.5]
}

export interface MomentumEvent extends MomentumSnapshot {
  id: string;
  episodeId: string;
}

export enum EpisodeState {
  BUILDING = "BUILDING",
  PEAK = "PEAK",
  FADING = "FADING",
  DEAD = "DEAD",
}

export enum LifecycleEventType {
  MOMENTUM_EVENT = "MOMENTUM_EVENT",
  MOMENTUM_FADING = "MOMENTUM_FADING",
  MOMENTUM_REIGNITED = "MOMENTUM_REIGNITED",
  MOMENTUM_DEAD = "MOMENTUM_DEAD",
}

export interface DecayEvidence {
  accelerationReversal: number; // each in [0,1]
  volumeFade: number;
  extremeStall: number;
  pullbackDepth: number;
  flowFlip?: number; // live only
  underlyingDivergence: number;
}

export interface Episode {
  id: string;
  instrumentKey: string;
  direction: Direction;
  openedAt: number;
  state: EpisodeState;
  ignition: { score: number; windowVol: number; velocity: number; premium: number };
  peak: { score: number; premiumExtreme: number; ts: number };
  decayScore: number; // 0–100
  decayEvidence: DecayEvidence;
  closedAt?: number;
  /** premium at FADING signal ÷ peak premium move — set on close (SPEC §14.5) */
  givebackPct?: number;
}

export interface LifecycleTransition {
  type: LifecycleEventType;
  episode: Episode;
  ts: number;
  /** human-readable, DESCRIPTIVE evidence line rendered from templates.ts */
  summary: string;
}

/** Abstraction letting live feed / file replay / backtest share one pipeline. */
export interface TickSource {
  start(onTick: (t: Tick) => void): Promise<void>;
  stop(): Promise<void>;
}

/** §12.8 D30 focus pool status, surfaced on /health and WS /live. */
export interface FocusPoolState {
  slots: string[];
  capacity: number;
  connectionState: string;
}
