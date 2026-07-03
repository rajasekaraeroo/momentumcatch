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
          segment: "NSE_FO",
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
      segment: "NSE_FO",
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

  it("parses BSE_FO (SENSEX) rows only when the segment is requested (§12.8b)", () => {
    const row = {
      segment: "BSE_FO",
      instrument_key: "BSE_FO|998877",
      instrument_type: "CE",
      underlying_symbol: "SENSEX",
      strike_price: 81000,
      expiry: "2026-07-09",
      lot_size: 20,
    };
    // requesting the BSE segment yields the SENSEX contract...
    expect(parseMasterRow(row, "BSE_FO")).toEqual({
      instrumentKey: "BSE_FO|998877",
      underlyingSymbol: "SENSEX",
      strike: 81000,
      side: 1,
      expiry: "2026-07-09",
      lotSize: 20,
      segment: "BSE_FO",
    });
    // ...while the default (NSE_FO) filter rejects it, keeping dumps separate
    expect(parseMasterRow(row)).toBeNull();
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

  it("selects BSE_FO (SENSEX) contracts identically to NSE ones (§12.8b)", () => {
    // SENSEX trades on BSE with a 100-point strike step; selection is
    // exchange-agnostic and keys through unchanged from the master.
    const sensex: MasterOption[] = [];
    for (let strike = 80_000; strike <= 82_000; strike += 100) {
      for (const side of [1, -1] as const) {
        sensex.push({
          instrumentKey: `BSE_FO|${strike}${side === 1 ? "CE" : "PE"}`,
          underlyingSymbol: "SENSEX",
          strike,
          side,
          expiry: "2026-07-09",
          lotSize: 20,
          segment: "BSE_FO",
        });
      }
    }
    const sel = selectUniverse(sensex, {
      underlyingSymbol: "SENSEX",
      spot: 81_040,
      strikeStep: 100,
      atmRange: 10,
      todayIst: "2026-07-03",
      pastRollCutoff: false,
    });
    expect(sel?.atm).toBe(81_000);
    expect(sel?.options).toHaveLength(21 * 2);
    expect(sel?.options.every((o) => o.segment === "BSE_FO")).toBe(true);
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
