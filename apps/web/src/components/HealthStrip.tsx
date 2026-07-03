"use client";
import type { FeedStatus } from "../lib/live";
import { ENGINE_URL } from "../lib/live";

/** Feed health strip (SPEC §7.4) + login banner (SPEC §12.2). */

const STATE_COLOR: Record<string, string> = {
  LIVE: "var(--good)",
  CONNECTING: "var(--warn)",
  RECONNECTING: "var(--warn)",
  AWAITING_AUTH: "var(--warn)",
  TICK_STARVED: "var(--bad)",
  IDLE_CLOSED: "var(--ink-3)",
  STOPPED: "var(--bad)",
};

export function HealthStrip({
  feed,
  wsConnected,
}: {
  feed: FeedStatus | null;
  wsConnected: boolean;
}): JSX.Element {
  const m = feed?.metrics ?? {};
  return (
    <>
      <div className="panel health">
        <h1>MomentumScan</h1>
        <span className="chip">
          <span
            className="dot"
            style={{ background: feed ? STATE_COLOR[feed.state] ?? "var(--ink-3)" : "var(--bad)" }}
          />
          feed {feed?.state ?? "ENGINE OFFLINE"}
        </span>
        <span className="chip">
          <span className="dot" style={{ background: wsConnected ? "var(--good)" : "var(--bad)" }} />
          live socket {wsConnected ? "connected" : "down"}
        </span>
        <span className="chip">subs {feed?.subscriptionCount ?? 0}</span>
        <span className="chip">ticks/s {m.ticksPerSecond ?? 0}</span>
        <span className="chip">
          last tick {m.lastTickAgeMs == null ? "—" : `${Math.round((m.lastTickAgeMs as number) / 1000)}s ago`}
        </span>
        <span className="chip">reconnects {m.reconnects ?? 0}</span>
        <span className="chip">decode errors {m.decodeErrors ?? 0}</span>
      </div>
      {feed?.state === "AWAITING_AUTH" && (
        <div className="banner">
          Login required — Upstox tokens expire daily.{" "}
          <a href={`${ENGINE_URL}/auth/login`}>Complete the morning login</a> and
          the feed starts automatically.
        </div>
      )}
    </>
  );
}
