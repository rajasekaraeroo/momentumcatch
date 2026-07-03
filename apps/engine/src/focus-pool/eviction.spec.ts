import { describe, expect, it } from "vitest";
import { EpisodeState } from "@momentum-scan/shared";
import { pickEviction, type PoolCandidate } from "./eviction";

/**
 * §12.8 overflow policy: when the 51st episode arrives, the lowest-score
 * BUILDING episode is evicted and FADING episodes are untouched — decay
 * observation has priority.
 */

function slot(i: number, state: EpisodeState, score: number): PoolCandidate {
  return { key: `NSE_FO|SLOT${i}`, state, score };
}

describe("focus-pool eviction (§12.8)", () => {
  it("51st episode: lowest-score BUILDING is evicted, FADING untouched", () => {
    const candidates: PoolCandidate[] = [];
    // 20 FADING slots with LOW scores — protected despite being lowest
    for (let i = 0; i < 20; i++) candidates.push(slot(i, EpisodeState.FADING, 5 + i));
    // 25 BUILDING slots with mid scores; slot 20 is the lowest BUILDING
    for (let i = 20; i < 45; i++) candidates.push(slot(i, EpisodeState.BUILDING, 40 + i));
    // 5 PEAK slots with high scores (rank with BUILDING for eviction)
    for (let i = 45; i < 50; i++) candidates.push(slot(i, EpisodeState.PEAK, 90 + i));
    expect(candidates).toHaveLength(50);

    const victim = pickEviction(candidates);
    expect(victim).toBe("NSE_FO|SLOT20"); // lowest-score non-FADING
    // never a FADING slot, even though every FADING score is lower
    const fadingKeys = candidates
      .filter((c) => c.state === EpisodeState.FADING)
      .map((c) => c.key);
    expect(fadingKeys).not.toContain(victim);
  });

  it("PEAK is not protected — lowest-score PEAK loses to a higher BUILDING", () => {
    const victim = pickEviction([
      slot(1, EpisodeState.BUILDING, 80),
      slot(2, EpisodeState.PEAK, 55),
      slot(3, EpisodeState.FADING, 10),
    ]);
    expect(victim).toBe("NSE_FO|SLOT2");
  });

  it("only when every slot is FADING does the lowest-score FADING go", () => {
    const victim = pickEviction([
      slot(1, EpisodeState.FADING, 61),
      slot(2, EpisodeState.FADING, 12),
      slot(3, EpisodeState.FADING, 40),
    ]);
    expect(victim).toBe("NSE_FO|SLOT2");
  });

  it("unknown episode state ranks as unprotected; empty pool → null", () => {
    expect(pickEviction([])).toBeNull();
    const victim = pickEviction([
      slot(1, EpisodeState.FADING, 5),
      { key: "NSE_FO|GONE", state: undefined, score: 99 },
    ]);
    expect(victim).toBe("NSE_FO|GONE");
  });
});
