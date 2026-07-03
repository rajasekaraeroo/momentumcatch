/** Feed metrics counters, exposed on /health (SPEC §9). */
export class FeedMetrics {
  ticksTotal = 0;
  dataFramesTotal = 0;
  marketInfoFramesTotal = 0;
  decodeErrors = 0;
  duplicatesDropped = 0;
  largeSkewTicks = 0;
  reconnects = 0;
  streamPublishErrors = 0;
  lastTickAtMs: number | null = null;

  private readonly tickTimestamps: number[] = [];

  onTick(now: number): void {
    this.ticksTotal += 1;
    this.lastTickAtMs = now;
    this.tickTimestamps.push(now);
    // keep 10s of samples for the rate calculation
    const cutoff = now - 10_000;
    while (this.tickTimestamps.length && (this.tickTimestamps[0] ?? 0) < cutoff) {
      this.tickTimestamps.shift();
    }
  }

  ticksPerSecond(now: number): number {
    const cutoff = now - 10_000;
    const inWindow = this.tickTimestamps.filter((t) => t >= cutoff).length;
    return Math.round((inWindow / 10) * 10) / 10;
  }

  snapshot(now: number): Record<string, number | null> {
    return {
      ticksTotal: this.ticksTotal,
      dataFramesTotal: this.dataFramesTotal,
      marketInfoFramesTotal: this.marketInfoFramesTotal,
      decodeErrors: this.decodeErrors,
      duplicatesDropped: this.duplicatesDropped,
      largeSkewTicks: this.largeSkewTicks,
      reconnects: this.reconnects,
      streamPublishErrors: this.streamPublishErrors,
      ticksPerSecond: this.ticksPerSecond(now),
      lastTickAgeMs: this.lastTickAtMs === null ? null : now - this.lastTickAtMs,
    };
  }
}
