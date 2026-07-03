/**
 * Market-hours gate (SPEC §2): connect/disconnect times in IST, skip
 * weekends and NSE holidays from config/holidays.json.
 *
 * IST is a fixed UTC+05:30 offset with no daylight saving, so plain
 * arithmetic is safe here.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstClock {
  /** YYYY-MM-DD in IST */
  dateIst: string;
  /** minutes since midnight IST */
  minutesIst: number;
  /** 0=Sunday … 6=Saturday, in IST */
  dayOfWeekIst: number;
}

export function toIst(utcMs: number): IstClock {
  const shifted = new Date(utcMs + IST_OFFSET_MS);
  const dateIst = shifted.toISOString().slice(0, 10);
  return {
    dateIst,
    minutesIst: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dayOfWeekIst: shifted.getUTCDay(),
  };
}

export function parseHhMm(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface MarketSchedule {
  connectIst: string;
  disconnectIst: string;
  holidays: Set<string>;
}

/**
 * TTL for hot Redis keys: expire 1 hour past market close (SPEC §4). After
 * close, returns the residual (min 60s) so stale keys still die quickly.
 */
export function hotKeyTtlSec(utcMs: number, disconnectIst: string): number {
  const ist = toIst(utcMs);
  const closeMin = parseHhMm(disconnectIst);
  const secsUntilClose = closeMin * 60 - (ist.minutesIst * 60);
  return Math.max(60, secsUntilClose + 3600);
}

/** True when the feed should be connected (SPEC §2 schedule window). */
export function isWithinFeedWindow(utcMs: number, sched: MarketSchedule): boolean {
  const ist = toIst(utcMs);
  if (ist.dayOfWeekIst === 0 || ist.dayOfWeekIst === 6) return false;
  if (sched.holidays.has(ist.dateIst)) return false;
  const open = parseHhMm(sched.connectIst);
  const close = parseHhMm(sched.disconnectIst);
  return ist.minutesIst >= open && ist.minutesIst < close;
}
