import { describe, expect, it } from "vitest";
import { secondsUntilTokenExpiry } from "./token-ttl";

describe("secondsUntilTokenExpiry (SPEC §12.2 — expire 03:30 IST next day)", () => {
  it("token stored mid-morning IST expires 03:30 IST next day", () => {
    // 2026-07-01 09:30 IST == 04:00 UTC; until 2026-07-02 03:30 IST is 18h
    const now = Date.UTC(2026, 6, 1, 4, 0, 0);
    expect(secondsUntilTokenExpiry(now)).toBe(18 * 3600);
  });

  it("token seen just after midnight IST expires 03:30 IST the same day", () => {
    // 2026-07-01 01:00 IST == 2026-06-30 19:30 UTC → 2.5h to 03:30 IST
    const now = Date.UTC(2026, 5, 30, 19, 30, 0);
    expect(secondsUntilTokenExpiry(now)).toBe(2.5 * 3600);
  });

  it("never returns zero or negative", () => {
    // exactly 03:30 IST → full day ahead
    const now = Date.UTC(2026, 6, 0, 22, 0, 0); // 2026-07-01 03:30 IST
    expect(secondsUntilTokenExpiry(now)).toBe(24 * 3600);
  });
});
