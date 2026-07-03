import { EpisodeState } from "@momentum-scan/shared";

/**
 * §12.8 overflow policy, pure: evict the lowest current composite score,
 * but NEVER evict FADING episodes ahead of BUILDING/PEAK ones — decay
 * observation has priority, it is the reason the pool exists. Only when
 * every slot is FADING does the lowest-score FADING slot go.
 */
export interface PoolCandidate {
  key: string;
  state: EpisodeState | undefined;
  score: number;
}

export function pickEviction(candidates: PoolCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const unprotected = candidates.filter((c) => c.state !== EpisodeState.FADING);
  const pool = unprotected.length > 0 ? unprotected : candidates;
  let lowest = pool[0] as PoolCandidate;
  for (const c of pool) if (c.score < lowest.score) lowest = c;
  return lowest.key;
}
