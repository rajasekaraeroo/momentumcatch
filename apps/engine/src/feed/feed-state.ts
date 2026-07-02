/** Feed connection state surfaced on /health and the dashboard (SPEC §9, §12). */
export enum FeedState {
  /** no valid Upstox token — waiting for the morning login (SPEC §12.2) */
  AWAITING_AUTH = "AWAITING_AUTH",
  /** outside the market-hours window, deliberately disconnected */
  IDLE_CLOSED = "IDLE_CLOSED",
  CONNECTING = "CONNECTING",
  LIVE = "LIVE",
  RECONNECTING = "RECONNECTING",
  /** connected but no data frames despite escalation (SPEC §12.6.1) */
  TICK_STARVED = "TICK_STARVED",
  STOPPED = "STOPPED",
}
