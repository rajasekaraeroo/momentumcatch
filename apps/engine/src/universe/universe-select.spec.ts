import { describe, expect, it } from "vitest";
import {
  needsRecenter,
  parseMasterRow,
  selectUniverse,
  subscriptionDiff,
  type MasterOption,
} from "./universe-select";

/** synthetic instruments-master rows for two weekly expiries */
function fixtureMaster(): MasterOption[] {
  const rows: MasterOption[] = [];
  for (const expiry of ["2026-07-09", "2026-07-16"]) {
    for (let strike = 24000; strike <= 25600; strike += 50) {
      for (const side of [1, -1] as const) {
        rows.push({
          instrumentKey: `NSE_FO|${expiry}-${strike}${side === 1 ? "CE" : "PE"}`,
          underlyingSymbol: "NIFTY",
          strike,
          side,
          expiry,
          lotSize: 75,
        });
      }
    }
  }
  return rows;
}

describe("parseMasterRow (§12.3 — tolerant of schema variants)", () => {
  it("parses the documented field names", () => {
    const row = {
      segment: "NSE_FO",
      instrument_key: "NSE_FO|54321",
      instrument_type: "CE",
      underlying_symbol: "NIFTY",
      strike_price: 24800,
      expiry: "2026-07-09",
      lot_size: 75,
    };
    expect(parseMasterRow(row)).toEqual({
      instrumentKey: "NSE_FO|54321",
      underlyingSymbol: "NIFTY",
      strike: 24800,
      side: 1,
      expiry: "2026-07-09",
      lotSize: 75,
    });
  });
  it("handles epoch-ms expiry and rejects non-options", () => {
    const row = {
      segment: "NSE_FO",
      instrument_key: "NSE_FO|1",
      instrument_type: "PE",
      underlying_symbol: "NIFTY",
      strike_price: 24000,
      expiry: Date.UTC(2026, 6, 9),
    };
    expect(parseMasterRow(row)?.expiry).toBe("2026-07-09");
    expect(parseMasterRow({ ...row, instrument_type: "FUT" })).toBeNull();
    expect(parseMasterRow({ ...row, segment: "NSE_EQ" })).toBeNull();
  });
});

describe("selectUniverse (§2)", () => {
  const master = fixtureMaster();
  const base = {
    underlyingSymbol: "NIFTY",
    strikeStep: 50,
    atmRange: 10,
    todayIst: "2026-07-03",
    pastRollCutoff: false,
  };

  it("picks nearest weekly expiry, ATM ± N, CE & PE", () => {
    const sel = selectUniverse(master, { ...base, spot: 24_812 });
    expect(sel?.expiry).toBe("2026-07-09");
    expect(sel?.atm).toBe(24_800);
    expect(sel?.options).toHaveLength(21 * 2); // ATM±10 strikes × CE/PE
    const strikes = new Set(sel?.options.map((o) => o.strike));
    expect(Math.min(...strikes)).toBe(24_300);
    expect(Math.max(...strikes)).toBe(25_300);
  });

  it("rolls to the next expiry after the cutoff on expiry day", () => {
    const onExpiry = { ...base, todayIst: "2026-07-09", spot: 24_800 };
    expect(selectUniverse(master, onExpiry)?.expiry).toBe("2026-07-09");
    expect(
      selectUniverse(master, { ...onExpiry, pastRollCutoff: true })?.expiry,
    ).toBe("2026-07-16");
  });

  it("clips at the edge of available strikes and rounds ATM", () => {
    const sel = selectUniverse(master, { ...base, spot: 24_024 });
    expect(sel?.atm).toBe(24_000);
    // lower half clipped at 24000 (no strikes below)
    expect(sel?.options.filter((o) => o.strike < 24_000)).toHaveLength(0);
  });

  it("returns null when nothing matches", () => {
    expect(
      selectUniverse(master, { ...base, underlyingSymbol: "BANKNIFTY", spot: 52_000 }),
    ).toBeNull();
  });
});

describe("re-centering + diffs (§2)", () => {
  it("triggers only beyond the drift threshold", () => {
    expect(needsRecenter(24_960, 24_800, 50, 3)).toBe(true);
    expect(needsRecenter(24_940, 24_800, 50, 3)).toBe(false);
  });
  it("computes minimal sub/unsub diffs", () => {
    expect(subscriptionDiff(["a", "b", "c"], ["b", "c", "d"])).toEqual({
      add: ["d"],
      remove: ["a"],
    });
  });
});
