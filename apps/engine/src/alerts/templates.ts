import type { Episode, MomentumEvent } from "@momentum-scan/shared";
import { LifecycleEventType } from "@momentum-scan/shared";

/**
 * ALL user-facing alert copy lives in THIS file and nowhere else, so it can
 * be audited in one place (CLAUDE.md hard rule 1; scripts/compliance-check.sh
 * scans it). Every string is DESCRIPTIVE — it reports observed market data
 * patterns. Nothing here may suggest an action or a trade.
 */

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

export function momentumEventSummary(e: MomentumEvent): string {
  const vel = e.components.find((c) => c.name === "velocity");
  const burst = e.components.find((c) => c.name === "volumeBurst");
  const dir = e.direction > 0 ? "rising" : "falling";
  const parts = [
    `High momentum observed — score ${Math.round(e.score)}, premium ${dir}`,
    e.classification.toLowerCase().replace(/_/g, " "),
  ];
  if (vel?.available) parts.push(`velocity ${vel.normalized.toFixed(2)}`);
  if (burst?.available) parts.push(`volume burst ${burst.normalized.toFixed(2)}`);
  return parts.join(", ") + ".";
}

export function lifecycleSummary(type: LifecycleEventType, ep: Episode, ts: number): string {
  const age = secs(ts - ep.openedAt);
  const d = ep.decayEvidence;
  switch (type) {
    case LifecycleEventType.MOMENTUM_FADING: {
      const drivers: string[] = [];
      if (d.volumeFade > 0.5) drivers.push(`volume faded to well below ignition`);
      if (d.extremeStall > 0.5) drivers.push(`no new premium extreme recently`);
      if (d.accelerationReversal > 0.5) drivers.push(`acceleration reversed`);
      if (d.pullbackDepth > 0.5) drivers.push(`pullback beyond ATR budget`);
      if ((d.flowFlip ?? 0) > 0.5) drivers.push(`order-flow imbalance flipped`);
      if (d.underlyingDivergence > 0.5) drivers.push(`underlying no longer confirming`);
      return `Momentum fading — decay ${Math.round(ep.decayScore)} after ${age}: ${
        drivers.join("; ") || "multiple decay components rising"
      }.`;
    }
    case LifecycleEventType.MOMENTUM_REIGNITED:
      return `Momentum re-ignited after ${age} — decay collapsed and the score made a new episode high.`;
    case LifecycleEventType.MOMENTUM_DEAD:
      return `Momentum ended — episode lasted ${age}, peak score ${Math.round(
        ep.peak.score,
      )}${ep.givebackPct !== undefined ? `, giveback ${pct(ep.givebackPct)}` : ""}.`;
    case LifecycleEventType.MOMENTUM_EVENT:
      return `High momentum observed — score ${Math.round(ep.ignition.score)}.`;
  }
}
