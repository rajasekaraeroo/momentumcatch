/**
 * Upstox access tokens expire early the next morning (SPEC §12.2); we store
 * them with a TTL ending 03:30 IST the following day. IST = fixed UTC+05:30.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const EXPIRY_MINUTES_IST = 3 * 60 + 30;

export function secondsUntilTokenExpiry(nowUtcMs: number): number {
  const istNow = new Date(nowUtcMs + IST_OFFSET_MS);
  const minutesIst = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const expiry = new Date(istNow);
  expiry.setUTCHours(3, 30, 0, 0);
  // Tokens issued after 03:30 IST live until 03:30 tomorrow; a token seen
  // before 03:30 (unusual) expires at 03:30 today.
  if (minutesIst >= EXPIRY_MINUTES_IST) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return Math.max(1, Math.floor((expiry.getTime() - istNow.getTime()) / 1000));
}
