# MomentumScan

Real-time momentum **detection** engine for NSE index options (NIFTY / BANKNIFTY),
built on the Upstox Market Data Feed V3. Captures tick data, aggregates to
1-second bars, computes a composite momentum score from premium velocity,
volume bursts, OI patterns, order-flow imbalance and underlying confirmation,
and tracks each momentum episode through a lifecycle state machine
(BUILDING → PEAK → FADING → DEAD) so it can report **when momentum is dying**,
not just when it starts.

Includes a one-year historical backtester (1-minute resolution, Upstox
Expired Instruments APIs) and a tick-replay forward-validation harness.

> **This is an analytical tool.** It displays observed market data patterns
> only. It does not place orders, and it never produces buy/sell/entry/exit
> recommendations. Nothing in this repository is investment advice.

## Repository layout

```
docs/SPEC.md            Full implementation specification (start here)
CLAUDE.md               Instructions for Claude Code
apps/engine/            NestJS — feed handler, momentum engine, backtester, API
apps/web/               Next.js — dashboard (heat grid, event tape, drill-down)
packages/shared/        Types, indicator math, protobuf definitions
config/                 Universe, momentum weights, backtest windows, holidays
scripts/                Compliance check and utilities
```

## Prerequisites

- Node.js 20+, pnpm 9+
- Docker (PostgreSQL 16 + Redis 7 via `docker-compose.yml`)
- Upstox developer app (API key/secret) with redirect URI
  `http://localhost:3001/auth/upstox/callback`
- **Upstox Plus** plan — required for the Expired Instruments APIs (§13 backtest)

## Quick start

```bash
cp .env.example .env        # fill in Upstox credentials
docker compose up -d        # postgres + redis
pnpm install
pnpm dev                    # engine :3001, web :3000
```

Each trading morning: open the dashboard → click **Login** → complete the
Upstox OAuth + TOTP → the feed starts automatically (tokens expire daily).

## Backtest

```bash
pnpm backtest:download --from 2025-07-01 --to 2026-06-30 --underlying NIFTY
pnpm backtest -- --from 2025-07-01 --to 2026-06-30 --underlying NIFTY
# report written to reports/
```

Read `docs/SPEC.md` §13.0 for the fidelity statement before interpreting
results: the historical track runs at 1-minute resolution; depth/flow
components are validated only by live tick recording (Track B).

## Status

Scaffold + specification. Implementation is executed with Claude Code by
following `CLAUDE.md` and the build order in `docs/SPEC.md` §11.
