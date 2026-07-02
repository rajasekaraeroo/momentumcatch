import { describe, expect, it } from "vitest";
import { backoffMs, BACKOFF_CAP_MS } from "./backoff";

const noJitter = () => 0.5; // rng midpoint → jitter factor 1.0

describe("backoffMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(backoffMs(0, noJitter)).toBe(1_000);
    expect(backoffMs(1, noJitter)).toBe(2_000);
    expect(backoffMs(2, noJitter)).toBe(4_000);
    expect(backoffMs(4, noJitter)).toBe(16_000);
    expect(backoffMs(5, noJitter)).toBe(30_000);
    expect(backoffMs(20, noJitter)).toBe(BACKOFF_CAP_MS);
  });

  it("applies bounded jitter (±20%)", () => {
    expect(backoffMs(2, () => 0)).toBe(3_200);
    expect(backoffMs(2, () => 1)).toBe(4_800);
  });

  it("treats negative attempts as attempt 0", () => {
    expect(backoffMs(-3, noJitter)).toBe(1_000);
  });
});
