import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Bar } from "@momentum-scan/shared";
import { AppConfigService } from "../config/config.service";
import { createPool, runMigrations } from "../db/db.module";
import { parseHhMm, toIst } from "../feed/market-hours";
import { HistStore } from "../history/hist-store";
import { createLogger } from "../logger";
import { BacktestEngine, type BtInstrument } from "./backtest-engine";
import { loadBacktestConfig } from "./config";
import {
  captureRatio,
  ComponentSeparation,
  decileLift,
  labelDoublings,
  LiftTable,
  RunningMean,
  scoreBand,
  SCORE_BAND_ORDER,
  type ContractMinute,
} from "./expansion-analysis";

/**
 * §13 companion — DESCRIPTIVE premium-expansion analysis (research, not a
 * trading signal). See expansion-analysis.ts for the framing. Measures, over
 * near-ATM option minutes:
 *   • lift — how much more often the momentum score precedes a premium
 *     doubling than the unconditional base rate,
 *   • which indicator components separate doublers from non-doublers,
 *   • capture ratio — how much of the ideal trough→peak move a causally-known
 *     score-crossing could have reached, and the fading-glyph giveback.
 *
 *   pnpm backtest:expansion --from 2025-07-01 --to 2026-06-30 \
 *       --underlying BANKNIFTY --horizon 30 --multiple 2 --atm-strikes 3
 *
 * The tune/holdout split mirrors the backtester: results are reported for the
 * first `tuneMonths` and the untouched remainder separately, so a lift that
 * only appears in-sample is exposed as overfitting.
 */

const log = createLogger("expansion");

interface Accumulators {
  lift: LiftTable;
  sep: ComponentSeparation;
  capture: RunningMean;
  leadMinutes: RunningMean;
  crossings: number;
  crossingsDoubled: number;
  fadingGiveback: RunningMean;
  /** (value, doubled) pairs for the --by component, for decile lift */
  byObs: { value: number; doubled: boolean }[];
}

function newAcc(): Accumulators {
  return {
    lift: new LiftTable(),
    sep: new ComponentSeparation(),
    capture: new RunningMean(),
    leadMinutes: new RunningMean(),
    crossings: 0,
    crossingsDoubled: 0,
    fadingGiveback: new RunningMean(),
    byObs: [],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      underlying: { type: "string", default: "NIFTY" },
      horizon: { type: "string", default: "30" }, // forward minutes
      multiple: { type: "string", default: "2" }, // "doubling" = ×2
      "atm-strikes": { type: "string", default: "3" }, // ATM ± N
      lead: { type: "string", default: "30" }, // trough lookback (minutes)
      by: { type: "string", default: "" }, // bucket by a component decile instead of score band
      compression: { type: "boolean", default: false }, // restrict to low prior slow-velocity minutes
      "expiry-only": { type: "boolean", default: false }, // restrict to contracts expiring that session
      cutoff: { type: "string", default: "15:35" }, // end the daily window at HH:MM IST (e.g. 15:00)
      config: { type: "string", default: "config/backtest.yaml" },
    },
    args: process.argv.slice(2).filter((a) => a !== "--"),
  });
  if (!values.from || !values.to) {
    console.error(
      "usage: pnpm backtest:expansion --from YYYY-MM-DD --to YYYY-MM-DD --underlying BANKNIFTY [--horizon 30] [--multiple 2] [--atm-strikes 3] [--by oiDeltaRate] [--compression] [--expiry-only] [--cutoff 15:00]",
    );
    process.exit(2);
  }
  const horizon = Number(values.horizon);
  const multiple = Number(values.multiple);
  const atmStrikes = Number(values["atm-strikes"]);
  const lead = Number(values.lead);
  const byName = (values.by as string) || "";
  const compressionOn = Boolean(values.compression);
  const expiryOnly = Boolean(values["expiry-only"]);
  const openMin = parseHhMm("09:15");
  const cutoffMin = parseHhMm(values.cutoff as string);

  const config = new AppConfigService();
  const bt = loadBacktestConfig(config.repoRoot, values.config as string);
  const underlying = values.underlying as string;
  const uCfg = config.universe.underlyings.find((u) => u.symbol === underlying);
  if (!uCfg) throw new Error(`unknown underlying ${underlying} (not in config/universe.yaml)`);
  const strikeStep = uCfg.strikeStep;

  const pool = createPool(config.env.DATABASE_URL);
  await runMigrations(pool, `${config.repoRoot}/apps/engine`);
  const store = new HistStore(pool);

  // tune/holdout boundary (first tuneMonths = tune, rest = holdout)
  const tuneEnd = new Date(Date.parse(values.from as string));
  tuneEnd.setUTCMonth(tuneEnd.getUTCMonth() + bt.evaluation.tuneMonths);
  const tuneToIso = tuneEnd.toISOString().slice(0, 10);

  const tune = newAcc();
  const holdout = newAcc();

  const sessions = await store.sessions(
    underlying,
    Date.parse(values.from as string),
    Date.parse(values.to as string) + 86_400_000,
  );
  log.info(
    { sessions: sessions.length, horizon, multiple, atmStrikes, tuneToIso, expiryOnly, cutoff: values.cutoff, byName: byName || undefined, compressionOn },
    "premium-expansion analysis starting (descriptive — not a signal)",
  );

  let processed = 0;
  for (const day of sessions) {
    const acc = day < tuneToIso ? tune : holdout;
    const { contracts, candles } = await store.sessionCandles(underlying, day);
    const indexKey = `INDEX|${underlying}`;

    // session index reference = first index open at/after 09:15 IST
    let idxRef = 0;
    for (const c of candles) {
      if (c.instrumentKey !== indexKey) continue;
      if (toIst(c.ts).minutesIst >= openMin) {
        idxRef = c.o;
        break;
      }
    }
    if (idxRef <= 0) continue; // no usable index reference this session

    // near-ATM option instruments only (ATM ± atmStrikes); with --expiry-only,
    // keep only contracts whose expiry IS this session (expiry-day regime)
    const instruments = new Map<string, BtInstrument>();
    for (const [key, meta] of contracts) {
      if (key.startsWith("INDEX|") || meta.side === undefined || meta.strike === undefined) continue;
      if (expiryOnly && meta.expiry !== day) continue;
      if (Math.abs(meta.strike - idxRef) <= atmStrikes * strikeStep) {
        instruments.set(key, { key, side: meta.side, underlyingKey: indexKey, strike: meta.strike, expiry: meta.expiry });
      }
    }
    if (instruments.size === 0) continue;

    // feed = near-ATM options + the index, within the [09:15, cutoff) window
    // (cutoff < 15:30 trims the volatile last minutes, e.g. expiry-day blips);
    // bounding the feed makes every downstream series/label/snapshot respect it.
    const feed = candles.filter((c) => {
      if (!(instruments.has(c.instrumentKey) || c.instrumentKey === indexKey)) return false;
      const m = toIst(c.ts).minutesIst;
      return m >= openMin && m < cutoffMin;
    });
    const prevOi = new Map<string, number>();
    for (const c of feed) {
      if (c.oi !== undefined) {
        const p = prevOi.get(c.instrumentKey);
        c.oiDelta = p !== undefined ? c.oi - p : 0;
        prevOi.set(c.instrumentKey, c.oi);
      }
    }

    // per near-ATM contract: chronological series, forward doubling labels,
    // and a ts→local-index map for capture/lead lookups
    const series = new Map<string, ContractMinute[]>();
    const highs = new Map<string, number[]>();
    const lows = new Map<string, number[]>();
    const tsIndex = new Map<string, Map<number, number>>();
    const labels = new Map<string, boolean[]>();
    for (const c of feed) {
      if (!instruments.has(c.instrumentKey)) continue;
      if (toIst(c.ts).minutesIst < openMin) continue; // intraday, no pre-open
      const s = series.get(c.instrumentKey) ?? [];
      const hi = highs.get(c.instrumentKey) ?? [];
      const lo = lows.get(c.instrumentKey) ?? [];
      const ix = tsIndex.get(c.instrumentKey) ?? new Map<number, number>();
      ix.set(c.ts, s.length);
      s.push({ c: c.c, h: c.h, l: c.l });
      hi.push(c.h);
      lo.push(c.l);
      series.set(c.instrumentKey, s);
      highs.set(c.instrumentKey, hi);
      lows.set(c.instrumentKey, lo);
      tsIndex.set(c.instrumentKey, ix);
    }
    for (const [key, s] of series) labels.set(key, labelDoublings(s, horizon, multiple));

    const live = config.momentum.lifecycle;
    const engine = new BacktestEngine(
      bt,
      {
        decayWeights: live.decayWeights,
        volumeFadeFloorRatio: live.volumeFadeFloorRatio,
        pullbackAtrK: live.pullbackAtrK,
        fadingAt: live.fadingAt,
        reigniteBelow: live.reigniteBelow,
        deadAt: live.deadAt,
        deadScoreFloor: live.deadScoreFloor,
        maxEpisodeSteps: live.maxEpisodeSec,
      },
      instruments,
      {
        // every causal option-minute → lift + component separation
        onSnapshot: (snap, meta) => {
          const ix = tsIndex.get(meta.key)?.get(snap.ts);
          if (ix === undefined) return;
          // optional compression gate: keep only minutes where prior slow
          // velocity is below its baseline (a quiet/compressed premium)
          if (compressionOn) {
            const vs = snap.components.find((c) => c.name === "velocitySlow");
            if (!vs || !vs.available || vs.normalized >= 0) return;
          }
          const doubled = labels.get(meta.key)?.[ix] ?? false;
          acc.lift.add(scoreBand(snap.score), doubled);
          for (const comp of snap.components) {
            if (comp.available) acc.sep.add(comp.name, comp.normalized, doubled);
          }
          if (byName) {
            const bc = snap.components.find((c) => c.name === byName);
            if (bc && bc.available) acc.byObs.push({ value: bc.normalized, doubled });
          }
        },
        // score-crossing = reproducible-live analogue; measure capture + lead
        onEvent: (event, snap) => {
          const key = event.instrumentKey;
          const ix = tsIndex.get(key)?.get(event.ts);
          const hiArr = highs.get(key);
          const loArr = lows.get(key);
          if (ix === undefined || !hiArr || !loArr) return;
          acc.crossings += 1;
          const doubled = labels.get(key)?.[ix] ?? false;
          if (doubled) acc.crossingsDoubled += 1;
          // forward peak within the horizon
          let peak = snap.premium;
          const end = Math.min(hiArr.length - 1, ix + horizon);
          for (let j = ix + 1; j <= end; j++) peak = Math.max(peak, hiArr[j] as number);
          // trough = lowest low over the lead lookback up to the crossing
          let trough = snap.premium;
          let troughIx = ix;
          const start = Math.max(0, ix - lead);
          for (let j = start; j <= ix; j++) {
            if ((loArr[j] as number) < trough) {
              trough = loArr[j] as number;
              troughIx = j;
            }
          }
          if (peak > trough) {
            acc.capture.add(captureRatio(trough, snap.premium, peak));
            acc.leadMinutes.add(ix - troughIx);
          }
        },
        // fading-glyph giveback (premium at FADING ÷ peak move) — exit analogue
        onEpisodeClosed: (closed) => {
          if (closed.fadingGiveback !== null) acc.fadingGiveback.add(closed.fadingGiveback);
        },
      },
    );

    engine.newSession();
    const byMinute = new Map<number, Bar[]>();
    for (const c of feed) {
      const arr = byMinute.get(c.ts) ?? [];
      arr.push(c);
      byMinute.set(c.ts, arr);
    }
    for (const ts of [...byMinute.keys()].sort((a, b) => a - b)) {
      engine.step(ts, byMinute.get(ts) as Bar[]);
    }
    processed += 1;
    if (processed % 25 === 0) log.info({ processed, of: sessions.length }, "sessions analysed");
  }

  const report = renderReport({
    underlying,
    from: values.from as string,
    to: values.to as string,
    horizon,
    multiple,
    atmStrikes,
    tuneToIso,
    byName,
    compressionOn,
    expiryOnly,
    cutoff: values.cutoff as string,
    tune,
    holdout,
  });
  printConsole(underlying, byName, compressionOn, expiryOnly, tune, holdout);

  const dir = path.join(config.repoRoot, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${underlying}-expansion.html`);
  fs.writeFileSync(out, report, "utf8");
  log.info({ out }, "expansion report written");
  await pool.end();
}

function printConsole(
  underlying: string,
  byName: string,
  compressionOn: boolean,
  expiryOnly: boolean,
  tune: Accumulators,
  holdout: Accumulators,
): void {
  for (const [name, acc] of [
    ["TUNE", tune],
    ["HOLDOUT", holdout],
  ] as const) {
    const filter =
      (expiryOnly ? " · EXPIRY-DAY contracts only" : "") +
      (compressionOn ? " · COMPRESSION filter on (low prior slow-velocity minutes only)" : "");
    console.log(`\n=== ${underlying} — ${name}  (base rate ${acc.lift.baseRatePct().toFixed(2)}% of near-ATM minutes precede a move${filter}) ===`);
    if (byName) {
      console.log(`Lift by ${byName} decile (D01 lowest → D10 highest; lift ≈ 1 ⇒ no discrimination):`);
      console.table(
        decileLift(acc.byObs).map((r) => ({
          decile: r.label,
          minutes: r.fires,
          movedPct: Number(r.hitRatePct.toFixed(2)),
          lift: Number(r.lift.toFixed(2)),
        })),
      );
    }
    console.log("Lift by momentum-score band (lift ≈ 1 ⇒ no discrimination):");
    console.table(
      acc.lift.rows(SCORE_BAND_ORDER).map((r) => ({
        scoreBand: r.label,
        minutes: r.fires,
        movedPct: Number(r.hitRatePct.toFixed(2)),
        lift: Number(r.lift.toFixed(2)),
      })),
    );
    console.log("Component separation (avg normalized reading, doublers − others):");
    console.table(
      acc.sep.rows().map((r) => ({
        component: r.name,
        avgWhenDoubled: Number(r.avgWhenDoubled.toFixed(3)),
        avgWhenNot: Number(r.avgWhenNot.toFixed(3)),
        separation: Number(r.separation.toFixed(3)),
      })),
    );
    const crossPct = acc.crossings > 0 ? (100 * acc.crossingsDoubled) / acc.crossings : 0;
    console.log(
      `Score-crossings: ${acc.crossings} · followed by a doubling: ${crossPct.toFixed(1)}% · ` +
        `avg capture of ideal move: ${(100 * acc.capture.mean()).toFixed(1)}% · ` +
        `avg lead after trough: ${acc.leadMinutes.mean().toFixed(1)} min · ` +
        `avg fading giveback: ${(100 * acc.fadingGiveback.mean()).toFixed(1)}%`,
    );
  }
}

function renderReport(p: {
  underlying: string;
  from: string;
  to: string;
  horizon: number;
  multiple: number;
  atmStrikes: number;
  tuneToIso: string;
  byName: string;
  compressionOn: boolean;
  expiryOnly: boolean;
  cutoff: string;
  tune: Accumulators;
  holdout: Accumulators;
}): string {
  const esc = (s: string): string => s.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m] as string));
  const section = (name: string, acc: Accumulators): string => {
    const decileBlock = p.byName
      ? `<h3>Lift by ${esc(p.byName)} decile (D01 lowest → D10 highest)</h3>
    <table><thead><tr><th>decile</th><th>minutes</th><th>moved</th><th>lift</th></tr></thead><tbody>${decileLift(
      acc.byObs,
    )
      .map(
        (r) =>
          `<tr><td>${r.label}</td><td>${r.fires}</td><td>${r.hitRatePct.toFixed(2)}%</td><td>${r.lift.toFixed(2)}×</td></tr>`,
      )
      .join("")}</tbody></table>`
      : "";
    const liftRows = acc.lift
      .rows(SCORE_BAND_ORDER)
      .map(
        (r) =>
          `<tr><td>${r.label}</td><td>${r.fires}</td><td>${r.hitRatePct.toFixed(2)}%</td><td>${r.lift.toFixed(2)}×</td></tr>`,
      )
      .join("");
    const sepRows = acc.sep
      .rows()
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${r.avgWhenDoubled.toFixed(3)}</td><td>${r.avgWhenNot.toFixed(3)}</td><td>${r.separation.toFixed(3)}</td></tr>`,
      )
      .join("");
    const crossPct = acc.crossings > 0 ? (100 * acc.crossingsDoubled) / acc.crossings : 0;
    return `
    <h2>${name}</h2>
    <p>Base rate: <b>${acc.lift.baseRatePct().toFixed(2)}%</b> of near-ATM option minutes are followed by a ×${p.multiple} premium move within ${p.horizon} minutes${p.compressionOn ? " (compression filter on)" : ""}.</p>
    ${decileBlock}
    <h3>Lift by momentum-score band</h3>
    <table><thead><tr><th>score band</th><th>minutes</th><th>doubled</th><th>lift</th></tr></thead><tbody>${liftRows}</tbody></table>
    <h3>Component separation (avg normalized reading)</h3>
    <table><thead><tr><th>component</th><th>when doubled</th><th>otherwise</th><th>separation</th></tr></thead><tbody>${sepRows}</tbody></table>
    <h3>Reproducible-in-real-time analogues</h3>
    <ul>
      <li>Score-crossings observed: <b>${acc.crossings}</b>, of which <b>${crossPct.toFixed(1)}%</b> were followed by a doubling.</li>
      <li>Average capture of the ideal trough→peak move: <b>${(100 * acc.capture.mean()).toFixed(1)}%</b> (crossing arrives ~${acc.leadMinutes.mean().toFixed(1)} min after the trough).</li>
      <li>Average giveback at the fading glyph: <b>${(100 * acc.fadingGiveback.mean()).toFixed(1)}%</b> of the favorable move.</li>
    </ul>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.underlying)} — premium-expansion analysis</title>
  <style>
    body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
    h1{margin-bottom:.2rem} table{border-collapse:collapse;margin:.5rem 0 1.5rem;width:100%}
    th,td{border:1px solid #ddd;padding:.35rem .6rem;text-align:right} th:first-child,td:first-child{text-align:left}
    .grey{background:#f2f2f2;border-left:4px solid #999;padding:1rem;margin:1rem 0;font-size:.92rem;color:#333}
  </style></head><body>
  <h1>${esc(p.underlying)} — premium-expansion analysis</h1>
  <p>${esc(p.from)} → ${esc(p.to)} · daily window 09:15–${esc(p.cutoff)} IST · near-ATM ±${p.atmStrikes} strikes · move = ×${p.multiple} within ${p.horizon} min · tune/holdout split at ${esc(p.tuneToIso)}${p.expiryOnly ? " · <b>expiry-day contracts only</b>" : ""}${p.compressionOn ? " · compression filter on" : ""}.</p>
  <div class="grey"><b>What this is — and is not.</b> This page <i>describes</i> how often near-ATM option premiums doubled after the momentum indicator read high, versus a random minute (the base rate). <b>Lift</b> is the ratio; <b>~1 means no edge</b>. A finding is only credible if the lift and capture hold in the <b>holdout</b> section as well as the tune section. Even then this is a description of past market behavior computed on 1-minute closes with the live depth/flow signal switched off and no fills or slippage modelled — it is <b>not</b> a recommendation and nothing here describes when to act. Reproducible-live numbers use the causal score-crossing; the "ideal" trough is hindsight and cannot be traded.</div>
  ${section("Tune window", p.tune)}
  ${section("Holdout window", p.holdout)}
  </body></html>`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
