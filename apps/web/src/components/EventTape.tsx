"use client";
import type { TapeItem } from "../lib/live";

/**
 * Live event tape (SPEC §7.2) — reverse-chron, evidence-first: every
 * component's value and normalized score is shown; the evidence IS the
 * product. Lifecycle entries carry the template-rendered summary.
 */

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString("en-IN", {
    hour12: false,
    timeZone: "Asia/Kolkata",
  });

const LIFECYCLE_BADGE: Record<string, { label: string; color: string }> = {
  MOMENTUM_FADING: { label: "FADING", color: "var(--warn)" },
  MOMENTUM_REIGNITED: { label: "RE-IGNITED", color: "var(--rising)" },
  MOMENTUM_DEAD: { label: "ENDED", color: "var(--ink-3)" },
};

export function EventTape({ tape }: { tape: TapeItem[] }): JSX.Element {
  return (
    <div className="panel">
      <h2>Event tape</h2>
      <div className="tape">
        {tape.length === 0 && (
          <p style={{ color: "var(--ink-3)" }}>No momentum events observed yet.</p>
        )}
        {tape.map((item, i) => {
          if (item.kind === "event" && item.event) {
            const e = item.event;
            return (
              <div className="tape-item" key={`${e.id}-${i}`}>
                <div className="head">
                  <span className="key">{e.instrumentKey}</span>
                  <span
                    className="badge"
                    style={{
                      background: e.direction > 0 ? "rgba(65,132,228,0.25)" : "rgba(201,118,31,0.25)",
                      color: e.direction > 0 ? "#7fb0f0" : "#e0a866",
                    }}
                  >
                    score {Math.round(e.score)} · {e.direction > 0 ? "rising" : "falling"}
                  </span>
                  <span className="badge" style={{ border: "1px solid var(--border)", color: "var(--ink-2)" }}>
                    {e.classification.replace(/_/g, " ").toLowerCase()}
                  </span>
                  <span className="when">{fmtTime(e.ts)}</span>
                </div>
                <div className="evidence">
                  {e.components
                    .filter((c) => c.available)
                    .map((c) => (
                      <span className="comp" key={c.name}>
                        {c.name} {c.normalized >= 0 ? "+" : ""}
                        {c.normalized.toFixed(2)}
                      </span>
                    ))}
                  <span className="comp">confirm ×{e.underlyingConfirmation.toFixed(2)}</span>
                </div>
              </div>
            );
          }
          const t = item.lifecycle;
          if (!t) return null;
          const badge = LIFECYCLE_BADGE[t.type] ?? { label: t.type, color: "var(--ink-2)" };
          const d = t.episode.decayEvidence;
          return (
            <div className="tape-item" key={`${t.episode.id}-${t.type}-${i}`}>
              <div className="head">
                <span className="key">{t.episode.instrumentKey}</span>
                <span className="badge" style={{ border: `1px solid ${badge.color}`, color: badge.color }}>
                  {badge.label}
                </span>
                <span className="when">{fmtTime(t.ts)}</span>
              </div>
              <div className="summary">{t.summary}</div>
              <div className="evidence">
                <span className="comp">decay {Math.round(t.episode.decayScore)}</span>
                <span className="comp">accel-rev {d.accelerationReversal.toFixed(2)}</span>
                <span className="comp">vol-fade {d.volumeFade.toFixed(2)}</span>
                <span className="comp">stall {d.extremeStall.toFixed(2)}</span>
                <span className="comp">pullback {d.pullbackDepth.toFixed(2)}</span>
                {d.flowFlip !== undefined && <span className="comp">flow-flip {d.flowFlip.toFixed(2)}</span>}
                <span className="comp">divergence {d.underlyingDivergence.toFixed(2)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
