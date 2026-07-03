import type { Bar, Tick } from "@momentum-scan/shared";
import { depthImbalance } from "@momentum-scan/shared";

/**
 * Per-instrument 1-second bar aggregation (SPEC §4). Ticks are bucketed by
 * exchange `ltt` (SPEC §9 clock rule); a bucket closes when `flush(now)` is
 * called with a later second. Carry-forward bars (o=h=l=c=prev close, vol 0)
 * fill trade-less seconds so volume baselines see the zeros — except across
 * a feed gap (SPEC §9): after `markGap()` no synthetic bars are fabricated
 * and the first real bar is flagged `gap: true` so baselines restart.
 */

interface OpenBucket {
  sec: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  oiDelta: number;
  oi?: number;
  vwapNum: number;
  vwapDen: number;
  bidAskImbalance?: number;
}

/** if more than this many trade-less seconds elapse, treat as a gap instead
 *  of fabricating a window's worth of synthetic bars */
const MAX_CARRY_FORWARD_SEC = 60;

export class BarBuilder {
  private bucket: OpenBucket | null = null;
  private lastClose: number | null = null;
  private lastClosedSec: number | null = null;
  private prevCumVolume: number | null = null;
  private prevOi: number | null = null;
  private gapPending = false;
  lateTicksDropped = 0;

  constructor(readonly instrumentKey: string) {}

  markGap(): void {
    // Ticks were lost: drop the open bucket (it may be partial), stop
    // carry-forward, and poison volume/OI deltas until fresh state arrives.
    this.bucket = null;
    this.lastClose = null;
    this.lastClosedSec = null;
    this.prevCumVolume = null;
    this.prevOi = null;
    this.gapPending = true;
  }

  /** Ingest one tick; returns bars closed by this tick's arrival. */
  ingest(tick: Tick): Bar[] {
    const sec = Math.floor(tick.ts / 1000);
    if (
      (this.bucket && sec < this.bucket.sec) ||
      (this.lastClosedSec !== null && sec <= this.lastClosedSec)
    ) {
      this.lateTicksDropped += 1;
      return [];
    }

    const closed: Bar[] = [];
    if (this.bucket && sec > this.bucket.sec) {
      closed.push(...this.closeThrough(sec - 1));
    }

    if (!this.bucket) {
      this.bucket = {
        sec,
        o: tick.ltp,
        h: tick.ltp,
        l: tick.ltp,
        c: tick.ltp,
        vol: 0,
        oiDelta: 0,
        vwapNum: 0,
        vwapDen: 0,
      };
    }

    const b = this.bucket;
    b.h = Math.max(b.h, tick.ltp);
    b.l = Math.min(b.l, tick.ltp);
    b.c = tick.ltp;

    // Traded quantity for this tick: prefer the cumulative-volume delta
    // (robust against missed ticks within the feed), fall back to ltq.
    let qty = 0;
    if (tick.volume !== undefined) {
      if (this.prevCumVolume !== null && tick.volume >= this.prevCumVolume) {
        qty = tick.volume - this.prevCumVolume;
      }
      this.prevCumVolume = tick.volume;
    } else if (tick.ltq !== undefined) {
      qty = tick.ltq;
    }
    b.vol += qty;
    if (qty > 0) {
      b.vwapNum += tick.ltp * qty;
      b.vwapDen += qty;
    }

    if (tick.oi !== undefined) {
      if (this.prevOi !== null) b.oiDelta += tick.oi - this.prevOi;
      this.prevOi = tick.oi;
      b.oi = tick.oi;
    }

    const imb = depthImbalance(tick);
    if (imb !== undefined) b.bidAskImbalance = imb;

    return closed;
  }

  /**
   * Close every bucket up to and including `throughSec` (call each scheduler
   * second with now-1 so the still-open current second is never emitted).
   */
  flush(throughSec: number): Bar[] {
    return this.closeThrough(throughSec);
  }

  private closeThrough(throughSec: number): Bar[] {
    const out: Bar[] = [];
    if (this.bucket && this.bucket.sec <= throughSec) {
      out.push(this.emit(this.bucket));
      this.lastClosedSec = this.bucket.sec;
      this.lastClose = this.bucket.c;
      this.bucket = null;
    }
    // carry-forward for trade-less seconds after the last closed bar
    if (this.lastClose !== null && this.lastClosedSec !== null) {
      const missing = throughSec - this.lastClosedSec;
      if (missing > MAX_CARRY_FORWARD_SEC) {
        this.markGap();
        return out;
      }
      for (let s = this.lastClosedSec + 1; s <= throughSec; s++) {
        out.push({
          instrumentKey: this.instrumentKey,
          ts: s * 1000,
          o: this.lastClose,
          h: this.lastClose,
          l: this.lastClose,
          c: this.lastClose,
          vol: 0,
          oiDelta: 0,
          oi: this.prevOi ?? undefined,
          vwapNum: 0,
          vwapDen: 0,
        });
        this.lastClosedSec = s;
      }
    }
    return out;
  }

  private emit(b: OpenBucket): Bar {
    const bar: Bar = {
      instrumentKey: this.instrumentKey,
      ts: b.sec * 1000,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      vol: b.vol,
      oiDelta: b.oiDelta,
      oi: b.oi,
      vwapNum: b.vwapNum,
      vwapDen: b.vwapDen,
      bidAskImbalance: b.bidAskImbalance,
    };
    if (this.gapPending) {
      bar.gap = true; // first bar after an outage (SPEC §9)
      this.gapPending = false;
    }
    return bar;
  }
}
