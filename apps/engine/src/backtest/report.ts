import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import type { BacktestConfig } from "./config";

/**
 * §13.4 evaluation report (HTML + JSON under reports/). All language is
 * DESCRIPTIVE — distributions and counts, never recommendations. The §13.0
 * fidelity statement is included verbatim; synthetic runs carry a prominent
 * label.
 */

const FIDELITY_STATEMENT = `Tick-level history is not available from Upstox. Track A backtests the
momentum logic at 1-MINUTE resolution using the Expired Instruments APIs.
Components requiring live depth (order-flow imbalance §5.5, spread penalty)
are EXCLUDED in Track A; composite weights are renormalized over the
remaining components. Track A validates the concept and thresholds; Track B
(live tick recording + replay, §8) validates the full second-level engine
going forward. Results from Track A must not be read as guarantees of the
tick engine's behavior.`;

interface ReportMeta {
  underlying: string;
  from: string;
  to: string;
  synthetic: boolean;
  sessions: number;
}

const IST = `AT TIME ZONE 'Asia/Kolkata'`;

async function distributions(pool: Pool, runId: string, horizons: number[]) {
  const out: Record<string, unknown>[] = [];
  for (const h of horizons) {
    const r = await pool.query(
      `SELECT is_baseline,
              count(*) FILTER (WHERE fwd_returns->>'${h}' IS NOT NULL)::int AS n,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY (fwd_returns->>'${h}')::float) AS p25,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY (fwd_returns->>'${h}')::float) AS median,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY (fwd_returns->>'${h}')::float) AS p75,
              avg((fwd_returns->>'${h}')::float) AS mean
       FROM momentum_event_bt WHERE run_id = $1 AND fwd_returns->>'${h}' IS NOT NULL
       GROUP BY is_baseline ORDER BY is_baseline`,
      [runId],
    );
    for (const row of r.rows) {
      out.push({ horizonMin: h, sample: row.is_baseline ? "random-baseline" : "signal", ...row });
    }
  }
  return out;
}

export async function writeReport(
  pool: Pool,
  repoRoot: string,
  runId: string,
  bt: BacktestConfig,
  meta: ReportMeta,
): Promise<{ html: string; json: string }> {
  const q = async (sql: string) => (await pool.query(sql.replace(/\$RUN/g, `'${runId.replace(/'/g, "''")}'`))).rows;

  const counts = {
    total: await q(`SELECT count(*)::int AS events FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline`),
    byMoneyness: await q(`SELECT moneyness, count(*)::int AS n FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline GROUP BY 1 ORDER BY 1`),
    byHour: await q(`SELECT extract(hour FROM to_timestamp(ts/1000.0) ${IST})::int AS hour_ist, count(*)::int AS n
                     FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline GROUP BY 1 ORDER BY 1`),
    byMonth: await q(`SELECT to_char(to_timestamp(ts/1000.0) ${IST}, 'YYYY-MM') AS month, count(*)::int AS n
                      FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline GROUP BY 1 ORDER BY 1`),
    byClassification: await q(`SELECT classification, count(*)::int AS n,
                                      avg(mfe)::float AS avg_mfe, avg(mae)::float AS avg_mae,
                                      avg((fwd_returns->>'5')::float) AS avg_fwd5
                               FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline GROUP BY 1 ORDER BY n DESC`),
  };

  const dists = await distributions(pool, runId, bt.evaluation.horizonsMin);

  const hitRates = await q(`
    SELECT k, count(*)::int AS n,
           (count(*) FILTER (WHERE mfe > 0 AND (mae = 0 OR mfe >= k * mae)))::float / NULLIF(count(*),0) AS hit_rate
    FROM momentum_event_bt, unnest(ARRAY[${bt.evaluation.mfeMaeK.join(",")}]::float[]) AS k
    WHERE run_id = $RUN AND NOT is_baseline
    GROUP BY k ORDER BY k`);

  const episodes = await q(`
    SELECT count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (closed_at - opened_at)/60000.0) AS median_duration_min,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_score) AS median_peak_score,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY fading_giveback) FILTER (WHERE fading_giveback IS NOT NULL) AS median_giveback_at_fading,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY naive_giveback)  FILTER (WHERE naive_giveback  IS NOT NULL) AS median_giveback_naive_rule,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY giveback_pct)    FILTER (WHERE giveback_pct    IS NOT NULL) AS median_giveback_at_close
    FROM momentum_episode_bt WHERE run_id = $RUN`);

  const regimes = await q(`
    SELECT CASE
             WHEN extract(hour FROM to_timestamp(ts/1000.0) ${IST}) < 10
               OR (extract(hour FROM to_timestamp(ts/1000.0) ${IST}) = 10 AND extract(minute FROM to_timestamp(ts/1000.0) ${IST}) < 15)
               THEN 'first-hour'
             WHEN extract(hour FROM to_timestamp(ts/1000.0) ${IST}) >= 14 THEN 'last-hour'
             ELSE 'midday' END AS slice,
           count(*)::int AS n, avg((fwd_returns->>'5')::float) AS avg_fwd5, avg(mfe)::float AS avg_mfe
    FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline GROUP BY 1 ORDER BY 1`);

  const expirySlice = await q(`
    SELECT (to_char(to_timestamp(e.ts/1000.0) ${IST}, 'YYYY-MM-DD') =
            substring(e.instrument_key FROM '\\d{4}-\\d{2}-\\d{2}$')) AS expiry_day,
           count(*)::int AS n, avg((e.fwd_returns->>'5')::float) AS avg_fwd5
    FROM momentum_event_bt e WHERE e.run_id = $RUN AND NOT e.is_baseline GROUP BY 1 ORDER BY 1`);

  const stability = await q(`
    SELECT to_char(to_timestamp(ts/1000.0) ${IST}, 'YYYY-MM') AS month,
           count(*)::int AS events,
           avg((fwd_returns->>'5')::float) AS avg_fwd5,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (fwd_returns->>'5')::float) AS median_fwd5,
           avg(mfe)::float AS avg_mfe, avg(mae)::float AS avg_mae
    FROM momentum_event_bt WHERE run_id = $RUN AND NOT is_baseline
      AND fwd_returns->>'5' IS NOT NULL
    GROUP BY 1 ORDER BY 1`);

  const report = {
    runId,
    meta,
    fidelityStatement: FIDELITY_STATEMENT,
    counts,
    forwardReturnDistributions: dists,
    hitRates,
    episodes: episodes[0] ?? {},
    regimes,
    expirySlice,
    monthlyStability: stability,
    notes: [
      "All figures are descriptive statistics of observed (or synthetic) data. Nothing here is a recommendation.",
      "The signal question (§13.4.2): do signal forward-return distributions dominate the matched random baseline?",
      "Stability (§13.4.7): a signal concentrated in one or two months is a red flag — read the monthly table before the aggregate.",
      ...(meta.synthetic
        ? ["SYNTHETIC RUN: the dataset was generated to validate the pipeline. Figures carry NO information about real markets."]
        : []),
    ],
  };

  const dir = path.join(repoRoot, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${runId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const table = (rows: Record<string, unknown>[]): string => {
    if (!rows.length) return "<p>no rows</p>";
    const cols = Object.keys(rows[0] as object);
    const fmt = (v: unknown): string =>
      typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(5)) : String(v ?? "—");
    return `<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${cols.map((c) => `<td>${fmt((r as Record<string, unknown>)[c])}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MomentumScan backtest — ${runId}</title>
<style>body{background:#0e1116;color:#e6edf3;font:14px/1.5 system-ui;max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:20px}h2{font-size:15px;color:#9aa4af;margin-top:28px;text-transform:uppercase;letter-spacing:.06em}
table{border-collapse:collapse;margin:8px 0;font-variant-numeric:tabular-nums}
td,th{border:1px solid #262d36;padding:4px 10px;text-align:right}th{color:#9aa4af;font-weight:500}
td:first-child,th:first-child{text-align:left}
.banner{border:1px solid #d29922;color:#f2cc60;padding:10px 14px;border-radius:8px;margin:12px 0;font-weight:600}
.fidelity{border:1px solid #262d36;background:#161b22;padding:12px 16px;border-radius:8px;white-space:pre-wrap;color:#9aa4af;font-size:13px}
footer{margin-top:32px;color:#6e7781;border-top:1px solid #262d36;padding-top:10px;font-size:12px}</style></head><body>
<h1>MomentumScan — one-year 1-minute backtest report</h1>
<p>run <code>${runId}</code> · ${meta.underlying} · ${meta.from} → ${meta.to} · ${meta.sessions} sessions</p>
${meta.synthetic ? `<div class="banner">SYNTHETIC DATASET — pipeline validation only. These figures carry no information about real markets.</div>` : ""}
<h2>§13.0 fidelity statement</h2><div class="fidelity">${FIDELITY_STATEMENT}</div>
<h2>1 · event counts</h2>
<p>total: ${(counts.total[0] as { events: number })?.events ?? 0}</p>
<h3>by moneyness</h3>${table(counts.byMoneyness)}
<h3>by hour (IST)</h3>${table(counts.byHour)}
<h3>by month</h3>${table(counts.byMonth)}
<h2>2 · forward-return distributions — signal vs matched random baseline</h2>
<p>The entire question is whether signal forward-returns dominate the baseline.</p>
${table(dists as Record<string, unknown>[])}
<h2>3 · hit rate (MFE ≥ k × MAE within 10 min)</h2>${table(hitRates)}
<h2>4 · by classification</h2>${table(counts.byClassification)}
<h2>5 · episode analytics &amp; decay capture (§14.5)</h2>${table(episodes)}
<p>Decay capture compares the median giveback at the MomentumFading signal
against the naive score&lt;40 rule — the fading signal is expected to be
materially earlier (smaller giveback).</p>
<h2>6 · regime slices</h2><h3>time of day</h3>${table(regimes)}<h3>expiry day</h3>${table(expirySlice)}
<h2>7 · month-by-month stability</h2>
<p>A signal that only worked in one or two months is a red flag; the monthly
table below is the primary read, the aggregate above is secondary.</p>
${table(stability)}
<footer>Analytical report. Events were followed by the distributions shown; the
distribution of forward returns was as tabulated. Displays observed data
patterns only. Not investment advice.</footer>
</body></html>`;
  const htmlPath = path.join(dir, `${runId}.html`);
  fs.writeFileSync(htmlPath, html);
  return { html: htmlPath, json: jsonPath };
}
