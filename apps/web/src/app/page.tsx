"use client";
import { useState } from "react";
import { DrillDown } from "../components/DrillDown";
import { EventTape } from "../components/EventTape";
import { HeatGrid } from "../components/HeatGrid";
import { HealthStrip } from "../components/HealthStrip";
import { useLive } from "../lib/live";

export default function Page(): JSX.Element {
  const live = useLive();
  const [selected, setSelected] = useState<string | null>(null);

  const atmBySymbol = new Map(live.selections.map((s) => [s.underlying, s.atm]));

  return (
    <main>
      <HealthStrip feed={live.feed} focusPool={live.focusPool} wsConnected={live.connected} />
      <div className="grid-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <HeatGrid
            instruments={live.instruments}
            snapshots={live.snapshots}
            episodes={live.episodes}
            atmBySymbol={atmBySymbol}
            selected={selected}
            onSelect={setSelected}
          />
          <DrillDown instrumentKey={selected} live={live} />
        </div>
        <EventTape tape={live.tape} />
      </div>
    </main>
  );
}
