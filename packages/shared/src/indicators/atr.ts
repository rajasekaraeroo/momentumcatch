import type { Bar } from "../types";

/**
 * Average true range over the trailing `n` bars (SPEC §5.8, §14.2.4 —
 * "30s ATR" live / candles in backtest). Simple mean of true ranges.
 */
export function atr(bars: Bar[], n: number): number {
  const win = bars.slice(-n);
  if (win.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < win.length; i++) {
    const b = win[i] as Bar;
    const prevClose = i > 0 ? (win[i - 1] as Bar).c : b.o;
    sum += Math.max(
      b.h - b.l,
      Math.abs(b.h - prevClose),
      Math.abs(b.l - prevClose),
    );
  }
  return sum / win.length;
}
