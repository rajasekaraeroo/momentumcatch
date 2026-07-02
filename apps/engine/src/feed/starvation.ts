/**
 * Tick-starvation detector (SPEC §12.6.1): connected during market hours yet
 * receiving no DATA frames (market_info-only counts as starved). Escalation
 * is driven by the feed service: resubscribe once → reconnect → TICK_STARVED.
 */
export class StarvationMonitor {
  private connectedAt: number | null = null;
  private lastDataFrameAt: number | null = null;

  constructor(private readonly starvedAfterMs = 20_000) {}

  onConnected(now: number): void {
    this.connectedAt = now;
    this.lastDataFrameAt = null;
  }

  onDisconnected(): void {
    this.connectedAt = null;
    this.lastDataFrameAt = null;
  }

  onDataFrame(now: number): void {
    this.lastDataFrameAt = now;
  }

  /** ms since the last data frame (or since connect if none arrived yet). */
  dataSilenceMs(now: number): number | null {
    if (this.connectedAt === null) return null;
    return now - (this.lastDataFrameAt ?? this.connectedAt);
  }

  isStarved(now: number): boolean {
    const silence = this.dataSilenceMs(now);
    return silence !== null && silence > this.starvedAfterMs;
  }
}
