"use client";
import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "@momentum-scan/shared";
import { ENGINE_URL, type LiveState } from "../lib/live";

/**
 * Instrument drill-down (SPEC §7.3): 1s candles + volume, with the momentum
 * score in its OWN pane below (never a second axis on the price chart).
 * Bars come from GET /instrument/:key/bars; the score line accumulates from
 * live snapshots.
 */

const CHART_OPTS = {
  layout: {
    background: { color: "#161b22" },
    textColor: "#9aa4af",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: "#20262e" },
    horzLines: { color: "#20262e" },
  },
  timeScale: { timeVisible: true, secondsVisible: true, borderColor: "#262d36" },
  rightPriceScale: { borderColor: "#262d36" },
  crosshair: { mode: 0 },
} as const;

export function DrillDown({
  instrumentKey,
  live,
}: {
  instrumentKey: string | null;
  live: LiveState;
}): JSX.Element {
  const priceRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{
    price?: IChartApi;
    score?: IChartApi;
    candles?: ISeriesApi<"Candlestick">;
    volume?: ISeriesApi<"Histogram">;
    scoreLine?: ISeriesApi<"Line">;
  }>({});

  // (re)create charts when the selected instrument changes
  useEffect(() => {
    if (!instrumentKey || !priceRef.current || !scoreRef.current) return;
    const price = createChart(priceRef.current, { ...CHART_OPTS, height: 260 });
    const score = createChart(scoreRef.current, { ...CHART_OPTS, height: 120 });
    const candles = price.addCandlestickSeries({
      upColor: "#2f9e6e",
      downColor: "#d9564a",
      wickUpColor: "#2f9e6e",
      wickDownColor: "#d9564a",
      borderVisible: false,
    });
    const volume = price.addHistogramSeries({
      priceScaleId: "vol",
      color: "rgba(110,119,129,0.5)",
      priceFormat: { type: "volume" },
    });
    price.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      visible: false,
    });
    const scoreLine = score.addLineSeries({
      color: "#4184e4",
      lineWidth: 2,
      priceLineVisible: false,
    });
    charts.current = { price, score, candles, volume, scoreLine };

    void fetch(`${ENGINE_URL}/instrument/${encodeURIComponent(instrumentKey)}/bars?window=300`)
      .then((r) => r.json())
      .then((bars: Bar[]) => {
        candles.setData(
          bars.map((b) => ({
            time: (b.ts / 1000) as UTCTimestamp,
            open: b.o, high: b.h, low: b.l, close: b.c,
          })),
        );
        volume.setData(
          bars.map((b) => ({ time: (b.ts / 1000) as UTCTimestamp, value: b.vol })),
        );
        price.timeScale().fitContent();
      })
      .catch(() => undefined);

    const hist = live.scoreHistory.get(instrumentKey) ?? [];
    scoreLine.setData(
      hist.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.score })),
    );

    return () => {
      price.remove();
      score.remove();
      charts.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentKey]);

  // stream live updates into the series
  useEffect(() => {
    const { candles, volume, scoreLine } = charts.current;
    if (!instrumentKey || !candles || !volume || !scoreLine) return;
    const timer = setInterval(() => {
      const snap = live.snapshots.get(instrumentKey);
      const hist = live.scoreHistory.get(instrumentKey);
      const last = hist?.[hist.length - 1];
      if (last) {
        scoreLine.update({ time: (last.ts / 1000) as UTCTimestamp, value: last.score });
      }
      if (snap?.premium !== undefined && snap.premium > 0) {
        const t = (snap.ts / 1000) as UTCTimestamp;
        candles.update({ time: t, open: snap.premium, high: snap.premium, low: snap.premium, close: snap.premium });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [instrumentKey, live]);

  return (
    <div className="panel">
      <h2>Drill-down {instrumentKey ? `— ${instrumentKey}` : ""}</h2>
      {!instrumentKey && (
        <p style={{ color: "var(--ink-3)" }}>
          Click a heat-grid cell to inspect its 1s candles, volume and score.
        </p>
      )}
      <div className="charts" style={{ display: instrumentKey ? "flex" : "none" }}>
        <div className="chart-box">
          <div className="chart-title">premium (1s candles) + volume</div>
          <div ref={priceRef} />
        </div>
        <div className="chart-box">
          <div className="chart-title">momentum score 0–100</div>
          <div ref={scoreRef} />
        </div>
      </div>
    </div>
  );
}
