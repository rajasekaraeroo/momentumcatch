# CLAUDE.md — Instructions for Claude Code

## What this project is

MomentumScan: a descriptive momentum-detection system for NSE options using
the Upstox V3 market data feed, with a lifecycle/decay engine and a one-year
1-minute backtester. The complete specification is `docs/SPEC.md`. Read it
in full before writing code. It is the source of truth; this file only adds
working conventions.

## Hard rules (never violate)

1. **Descriptive only.** No buy/sell/entry/target/stoploss language anywhere —
   code identifiers, UI strings, alert templates, comments, docs. Alert copy
   lives ONLY in `apps/engine/src/alerts/templates.ts` so it can be audited.
   `scripts/compliance-check.sh` enforces this in CI; keep it passing.
2. **No order APIs.** Never import or call Upstox order endpoints
   (`/v2/order/**`, `/v3/order/**`, `/v2/gtt/**`). Market data + login only.
3. **No lookahead in the backtester.** State at time t uses candles ≤ t only.
   The poisoned-future fixture test (SPEC §13.3) must exist and pass.
4. **Never log or commit secrets.** Token lives in Redis; `.env` is gitignored.

## Build order

Follow SPEC §11 stages strictly. Complete a stage, make it runnable, run its
tests, then stop and summarize before the next stage. Stage 1 acceptance:
decoded live ticks logging to stdout during market hours (or replay of a
recorded sample outside hours). Stage 8 (historical downloader + backtester)
may proceed in parallel with 1–7.

## Conventions

- pnpm workspaces; TypeScript strict everywhere; no `any` without a comment.
- Indicator math lives in `packages/shared/src/indicators/` as pure functions
  with unit tests — both the live engine (1s) and backtester (1m) import the
  same functions with different window configs. Never duplicate the math.
- Types in `packages/shared/src/types.ts` are the canonical interfaces
  (Tick, Bar, MomentumEvent, Episode, lifecycle enums). Extend there, not
  locally.
- NestJS modules: `feed/`, `momentum/`, `lifecycle/`, `alerts/`, `history/`,
  `backtest/`, `auth/`, `health/`. Keep feed and momentum decoupled via the
  Redis stream so they can be split into separate processes later.
- Config is YAML in `config/`, validated with zod at startup; fail fast on
  invalid config.
- Logging: pino, structured. Metrics counters exposed on `/health`.
- Tests: vitest for unit; keep one small anonymized tick sample under
  `apps/engine/test/fixtures/` for deterministic replay tests.

## External references to verify at implementation time (do not trust memory)

- Upstox V3 feed subscription limits (single vs combined categories).
- `MarketDataFeedV3.proto` — download from Upstox developer docs into
  `packages/shared/proto/` (see that folder's README).
- Instruments master JSON schema field names.
- Historical Candle V3 1-minute availability window for indices.
- NSE trading holiday list → `config/holidays.json`.

## Definition of done for the whole project

- `pnpm dev` runs engine + web; morning login flow works; live heat grid,
  event tape and lifecycle glyphs update during market hours.
- `pnpm test` green, including compliance check and no-lookahead test.
- One-year backtest completes for NIFTY and produces the §13.4 report with
  the random-baseline comparison and the decay giveback comparison.
