/**
 * Descriptive premium-expansion analysis (research, NOT a trading signal).
 *
 * Question answered: when the momentum indicator reads high, how much more
 * often does a near-ATM option premium at least DOUBLE within a short horizon
 * than at a random minute? That ratio ("lift") — plus how much of the ideal
 * trough→peak move the causally-known score-crossing could have captured — is
 * a characterization of market behavior. It is deliberately descriptive: no
 * buy/sell/entry/exit semantics, in line with the project's hard rule.
 *
 * Every function here is pure and unit-tested. The forward-looking labels
 * (did it double?) are the ANSWER KEY only — they are never fed back into the
 * indicator, which the backtest engine computes from candles ≤ t (no
 * look-ahead, SPEC §13.3).
 */

/** minute series for one contract, chronological (oldest→newest) */
export interface ContractMinute {
  c: number; // close premium
  h: number; // high
  l: number; // low
}

/**
 * For each minute i, true iff some later high within `horizon` minutes reaches
 * `multiple` × close[i] (i.e. the premium at least doubles going forward).
 * This is the forward outcome label — hindsight, used only to score the
 * indicator, never as an input to it.
 */
export function labelDoublings(
  series: ContractMinute[],
  horizon: number,
  multiple: number,
): boolean[] {
  const n = series.length;
  const out = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const target = (series[i] as ContractMinute).c * multiple;
    const end = Math.min(n - 1, i + horizon);
    for (let j = i + 1; j <= end; j++) {
      if ((series[j] as ContractMinute).h >= target) {
        out[i] = true;
        break;
      }
    }
  }
  return out;
}

export const SCORE_BAND_ORDER = ["00-40", "40-55", "55-70", "70-85", "85-100"];

export function scoreBand(score: number): string {
  if (score < 40) return "00-40";
  if (score < 55) return "40-55";
  if (score < 70) return "55-70";
  if (score < 85) return "70-85";
  return "85-100";
}

export interface LiftRow {
  label: string;
  fires: number;
  hits: number;
  hitRatePct: number;
  lift: number; // hitRate ÷ base rate; ~1 means no discrimination
}

/**
 * Buckets observations by a label (e.g. score band) and reports, per bucket,
 * how often the doubling label was true vs. the unconditional base rate.
 * `lift` > 1 means that bucket precedes doublings more than chance.
 */
export class LiftTable {
  private total = 0;
  private totalHits = 0;
  private readonly buckets = new Map<string, { fires: number; hits: number }>();

  add(bucketLabel: string, doubled: boolean): void {
    this.total += 1;
    if (doubled) this.totalHits += 1;
    const b = this.buckets.get(bucketLabel) ?? { fires: 0, hits: 0 };
    b.fires += 1;
    if (doubled) b.hits += 1;
    this.buckets.set(bucketLabel, b);
  }

  baseRatePct(): number {
    return this.total > 0 ? (100 * this.totalHits) / this.total : 0;
  }

  rows(order?: string[]): LiftRow[] {
    const base = this.total > 0 ? this.totalHits / this.total : 0;
    const keys = order
      ? order.filter((k) => this.buckets.has(k))
      : [...this.buckets.keys()];
    return keys.map((label) => {
      const b = this.buckets.get(label) as { fires: number; hits: number };
      const hitRate = b.fires > 0 ? b.hits / b.fires : 0;
      return {
        label,
        fires: b.fires,
        hits: b.hits,
        hitRatePct: 100 * hitRate,
        lift: base > 0 ? hitRate / base : 0,
      };
    });
  }
}

export interface ComponentSeparationRow {
  name: string;
  avgWhenDoubled: number;
  avgWhenNot: number;
  separation: number; // avgWhenDoubled − avgWhenNot; larger ⇒ more informative
  samples: number;
}

/**
 * For each indicator component, the mean normalized reading at minutes that
 * were followed by a doubling vs. minutes that were not. A large positive
 * separation means the component tends to be elevated ahead of doublings.
 */
export class ComponentSeparation {
  private readonly acc = new Map<
    string,
    { nD: number; sumD: number; nN: number; sumN: number }
  >();

  add(name: string, normalized: number, doubled: boolean): void {
    const a = this.acc.get(name) ?? { nD: 0, sumD: 0, nN: 0, sumN: 0 };
    if (doubled) {
      a.nD += 1;
      a.sumD += normalized;
    } else {
      a.nN += 1;
      a.sumN += normalized;
    }
    this.acc.set(name, a);
  }

  rows(): ComponentSeparationRow[] {
    return [...this.acc.entries()]
      .map(([name, a]) => {
        const avgD = a.nD > 0 ? a.sumD / a.nD : 0;
        const avgN = a.nN > 0 ? a.sumN / a.nN : 0;
        return {
          name,
          avgWhenDoubled: avgD,
          avgWhenNot: avgN,
          separation: avgD - avgN,
          samples: a.nD + a.nN,
        };
      })
      .sort((x, y) => y.separation - x.separation);
  }
}

/**
 * Fraction of the ideal trough→peak move that a causally-known crossing could
 * have captured. `trough` is the low that preceded the crossing (the ideal,
 * hindsight-only reference), `crossing` is the premium at the score-crossing
 * (reproducible live), `peak` is the later high. Clipped to [0, 1].
 */
export function captureRatio(
  trough: number,
  crossing: number,
  peak: number,
): number {
  const ideal = peak - trough;
  if (ideal <= 0) return 0;
  const captured = peak - crossing;
  return Math.max(0, Math.min(1, captured / ideal));
}

/** running mean of a stream of numbers (for averaging capture/lead/giveback) */
export class RunningMean {
  private n = 0;
  private sum = 0;
  add(x: number): void {
    this.n += 1;
    this.sum += x;
  }
  count(): number {
    return this.n;
  }
  mean(): number {
    return this.n > 0 ? this.sum / this.n : 0;
  }
}
