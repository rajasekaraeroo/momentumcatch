"use client";
import type { Episode } from "@momentum-scan/shared";
import type { LiveSnapshot, UniverseInstrument } from "../lib/live";

/**
 * Heat grid (SPEC §7.1): strikes × {CE, PE} per underlying. Cell fill is a
 * sequential alpha ramp of the live score in the direction hue (rising
 * #4184e4 / falling #c9761f — validated pair); lifecycle glyphs are the
 * secondary encoding (▲ building ● peak ▼ fading ✕ dead).
 */

const GLYPH: Record<string, string> = {
  BUILDING: "▲",
  PEAK: "●",
  FADING: "▼",
  DEAD: "✕",
};

function cellStyle(snap: LiveSnapshot | undefined): React.CSSProperties {
  if (!snap) return { background: "rgba(110,119,129,0.08)" };
  const alpha = Math.min(0.85, (snap.score / 100) * 0.85 + 0.05);
  const rgb = snap.direction > 0 ? "65,132,228" : "201,118,31";
  return { background: `rgba(${rgb},${alpha})` };
}

export function HeatGrid({
  instruments,
  snapshots,
  episodes,
  atmBySymbol,
  selected,
  onSelect,
}: {
  instruments: UniverseInstrument[];
  snapshots: Map<string, LiveSnapshot>;
  episodes: Map<string, Episode>;
  atmBySymbol: Map<string, number>;
  selected: string | null;
  onSelect: (key: string) => void;
}): JSX.Element {
  const options = instruments.filter((i) => i.kind === "option");
  const byUnderlying = new Map<string, UniverseInstrument[]>();
  for (const o of options) {
    const list = byUnderlying.get(o.underlying) ?? [];
    list.push(o);
    byUnderlying.set(o.underlying, list);
  }
  if (options.length === 0) {
    return (
      <div className="panel">
        <h2>Heat grid</h2>
        <p style={{ color: "var(--ink-3)" }}>
          No option universe resolved yet — appears after the first index print
          of the session (or with synthetic test keys).
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Heat grid — live momentum score</h2>
      {[...byUnderlying.entries()].map(([underlying, opts]) => {
        const strikes = [...new Set(opts.map((o) => o.strike ?? 0))].sort(
          (a, b) => b - a,
        );
        const atm = atmBySymbol.get(underlying);
        const find = (strike: number, side: 1 | -1) =>
          opts.find((o) => o.strike === strike && o.side === side);
        const cell = (o: UniverseInstrument | undefined) => {
          if (!o) return <td className="cell" />;
          const snap = snapshots.get(o.instrumentKey);
          const ep = episodes.get(o.instrumentKey);
          return (
            <td
              className={`cell${selected === o.instrumentKey ? " selected" : ""}`}
              style={cellStyle(snap)}
              onClick={() => onSelect(o.instrumentKey)}
              title={
                snap
                  ? `${o.instrumentKey} — score ${snap.score.toFixed(1)}, ${snap.classification}`
                  : o.instrumentKey
              }
            >
              {snap ? Math.round(snap.score) : "–"}
              {ep && <span className="glyph">{GLYPH[ep.state]}</span>}
            </td>
          );
        };
        return (
          <table className="heat" key={underlying}>
            <thead>
              <tr>
                <th>CE</th>
                <th>{underlying} strike</th>
                <th>PE</th>
              </tr>
            </thead>
            <tbody>
              {strikes.map((k) => (
                <tr key={k}>
                  {cell(find(k, 1))}
                  <td className={`strike${k === atm ? " atm" : ""}`}>{k || "—"}</td>
                  {cell(find(k, -1))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
      <p style={{ color: "var(--ink-3)", fontSize: 11, marginBottom: 0 }}>
        fill: score 0–100 · <span style={{ color: "#4184e4" }}>premium rising</span> ·{" "}
        <span style={{ color: "#c9761f" }}>premium falling</span> · ▲ building ● peak
        ▼ fading ✕ ended
      </p>
    </div>
  );
}
