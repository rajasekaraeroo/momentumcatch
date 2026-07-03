/**
 * Pure option-universe selection (SPEC §2, §12.3): from the parsed
 * instruments master pick ATM ± N strikes, CE & PE, of the nearest weekly
 * expiry — rolling to the next expiry after the cutoff on expiry day.
 *
 * Field names in the master vary between dumps; `parseMasterRow` accepts the
 * documented variants and must be VERIFIED against a freshly downloaded
 * file at first live run (SPEC §12.3 "do not trust memory of the schema").
 */

export interface MasterOption {
  instrumentKey: string;
  underlyingSymbol: string;
  strike: number;
  side: 1 | -1; // CE / PE
  expiry: string; // YYYY-MM-DD
  lotSize?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the instruments
   master is external JSON with drifting field names; every access below is
   guarded and normalized immediately. */
export function parseMasterRow(row: any): MasterOption | null {
  const segment = row?.segment ?? row?.exchange_segment;
  if (segment !== "NSE_FO") return null;
  const type = row?.instrument_type ?? row?.option_type;
  if (type !== "CE" && type !== "PE") return null;
  const instrumentKey = row?.instrument_key ?? row?.instrumentKey;
  const underlyingSymbol =
    row?.underlying_symbol ?? row?.asset_symbol ?? row?.name;
  const strike = Number(row?.strike_price ?? row?.strike);
  const expiryRaw = row?.expiry ?? row?.expiry_date;
  if (!instrumentKey || !underlyingSymbol || !Number.isFinite(strike) || !expiryRaw) {
    return null;
  }
  // expiry appears either as epoch ms or as a date string
  const expiry =
    typeof expiryRaw === "number"
      ? new Date(expiryRaw).toISOString().slice(0, 10)
      : String(expiryRaw).slice(0, 10);
  const lot = Number(row?.lot_size ?? row?.lotSize);
  return {
    instrumentKey,
    underlyingSymbol,
    strike,
    side: type === "CE" ? 1 : -1,
    expiry,
    lotSize: Number.isFinite(lot) ? lot : undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SelectionParams {
  underlyingSymbol: string; // NIFTY / BANKNIFTY
  spot: number;
  strikeStep: number;
  atmRange: number; // ATM ± N
  todayIst: string; // YYYY-MM-DD
  pastRollCutoff: boolean; // on expiry day, roll after cutoff (SPEC §2)
}

export interface UniverseSelection {
  expiry: string;
  atm: number;
  options: MasterOption[];
}

export function selectUniverse(
  master: MasterOption[],
  p: SelectionParams,
): UniverseSelection | null {
  const forUnderlying = master.filter(
    (o) => o.underlyingSymbol === p.underlyingSymbol && o.expiry >= p.todayIst,
  );
  if (forUnderlying.length === 0) return null;

  const expiries = [...new Set(forUnderlying.map((o) => o.expiry))].sort();
  let expiry = expiries[0] as string;
  if (expiry === p.todayIst && p.pastRollCutoff && expiries.length > 1) {
    expiry = expiries[1] as string;
  }

  const atm = Math.round(p.spot / p.strikeStep) * p.strikeStep;
  const lo = atm - p.atmRange * p.strikeStep;
  const hi = atm + p.atmRange * p.strikeStep;
  const options = forUnderlying
    .filter((o) => o.expiry === expiry && o.strike >= lo && o.strike <= hi)
    .sort((a, b) => a.strike - b.strike || a.side - b.side);
  return { expiry, atm, options };
}

/** §2 re-centering: true when spot drifted more than `driftStrikes` strikes
 *  from the current ATM. */
export function needsRecenter(
  spot: number,
  currentAtm: number,
  strikeStep: number,
  driftStrikes: number,
): boolean {
  return Math.abs(spot - currentAtm) > driftStrikes * strikeStep;
}

/** subscription diff for re-centering (SPEC §2 — diffs, not full resub) */
export function subscriptionDiff(
  current: string[],
  next: string[],
): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  return {
    add: next.filter((k) => !cur.has(k)),
    remove: current.filter((k) => !nxt.has(k)),
  };
}
