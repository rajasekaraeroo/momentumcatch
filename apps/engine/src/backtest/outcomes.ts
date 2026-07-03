import type { Direction } from "@momentum-scan/shared";

/**
 * Forward outcomes for an emitted event (SPEC §13.4): forward returns at
 * fixed horizons, MFE/MAE in the signal direction, and time-to-peak. Pure —
 * operates on the contract's candle closes AFTER the event, all within the
 * same session.
 */

export interface ForwardOutcome {
  fwdReturns: Record<string, number | null>; // horizon minutes → simple return
  mfe: number; // max favorable excursion (signed, direction-adjusted, fraction)
  mae: number; // max adverse excursion (positive fraction)
  timeToPeakMin: number | null;
}

export function forwardOutcomes(
  entryPremium: number,
  direction: Direction,
  /** closes at +1, +2, ... minutes after the event, session-bounded */
  forwardCloses: number[],
  horizonsMin: number[],
  maxWindowMin = 15,
): ForwardOutcome {
  const fwdReturns: Record<string, number | null> = {};
  for (const h of horizonsMin) {
    const px = forwardCloses[h - 1];
    fwdReturns[String(h)] =
      px !== undefined && entryPremium > 0
        ? (direction * (px - entryPremium)) / entryPremium
        : null;
  }
  let mfe = 0;
  let mae = 0;
  let timeToPeakMin: number | null = null;
  const window = forwardCloses.slice(0, maxWindowMin);
  window.forEach((px, i) => {
    if (entryPremium <= 0) return;
    const r = (direction * (px - entryPremium)) / entryPremium;
    if (r > mfe) {
      mfe = r;
      timeToPeakMin = i + 1;
    }
    if (-r > mae) mae = -r;
  });
  return { fwdReturns, mfe, mae, timeToPeakMin };
}

/** §13.4.3 hit rate predicate: MFE ≥ k × MAE within the window. */
export function isHit(outcome: ForwardOutcome, k: number): boolean {
  if (outcome.mfe <= 0) return false;
  if (outcome.mae === 0) return true;
  return outcome.mfe >= k * outcome.mae;
}
