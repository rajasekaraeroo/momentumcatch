# Claude Code Spec — Options Momentum Detection Engine ("MomentumScan")

## 0. Context & Ground Rules

You are building a real-time momentum detection system for NSE options inside an
existing TypeScript monorepo (Next.js frontend, NestJS backend, PostgreSQL, Redis,
Upstox as broker/data provider). If the monorepo does not exist yet, scaffold it
with pnpm workspaces: `apps/web` (Next.js 14+, App Router), `apps/engine` (NestJS),
`packages/shared` (types, protobuf, indicator math).

**COMPLIANCE CONSTRAINT (non-negotiable):** All output is DESCRIPTIVE, never
prescriptive. The system reports observed market states ("premium velocity +2.8σ,
volume burst 4.1x baseline, OI unwinding") — it must never emit "buy", "sell",
"entry", "target", "stop loss", or any trade recommendation. Enforce this in copy,
enum names, and UI labels. Alert text templates live in one file so they can be
audited.

**Do not implement any order placement. Data + analytics only.**

---

## 1. High-Level Architecture

```
Upstox Market Data Feed V3 (wss, protobuf)
        │  tick stream (LTPC + full mode)
        ▼
[Feed Handler]  apps/engine/src/feed
  - auth via /v3/feed/market-data-feed/authorize (follow redirects)
  - binary subscription messages, protobuf decode
  - auto-reconnect w/ exponential backoff, resubscribe on reconnect
  - heartbeat monitor (if no tick AND no ping for N sec → force reconnect)
        │  normalized Tick events
        ▼
[Redis Streams]  stream key: ticks:{instrumentKey}
  - also maintain hot rolling-window state in Redis hashes/sorted sets
        │
        ▼
[Momentum Engine]  apps/engine/src/momentum
  - per-instrument rolling windows: 5s / 30s / 60s / 300s
  - computes signal components every second (scheduler tick)
  - composite momentum score 0–100 + direction + evidence object
        │
        ├──► [Alert Service] → WebSocket gateway → Next.js dashboard
        │                    → optional Telegram webhook (config-gated)
        ▼
[Persistence]
  - PostgreSQL: 1s bars, signal events, session stats
  - Redis: hot state only (TTL-managed)
```

Single process is fine for v1 (one NestJS app with modules). Design module
boundaries so the feed handler and momentum engine could later be split.

---

## 2. Instrument Universe & Subscription Management

- Config-driven watchlist: `config/universe.yaml`
  - underlyings: NIFTY, BANKNIFTY (index), optional stock list
  - strikes: ATM ± N (default N=10) for nearest weekly expiry, CE & PE
  - auto-roll to next expiry on expiry day after a configurable cutoff time
- On startup and at a scheduled time daily (e.g., 08:45 IST):
  1. Pull the Upstox instruments master, resolve instrument keys for the
     current universe.
  2. Compute ATM from previous close (then re-center intraday if spot drifts
     more than a configurable number of strikes; re-centering triggers
     sub/unsub diffs, not a full resubscribe).
- Subscription modes: underlying index in `full`; options in `full` (need
  bid/ask depth + volume + OI). Respect V3 limits — combined-category limits
  are lower than single-category limits, so keep the universe well under the
  cap and log current subscription count at startup. Verify current limits
  against the live Upstox V3 docs at implementation time.
- Market-hours scheduler (IST): connect 09:00, disconnect 15:35, holiday
  calendar from a static JSON (editable), skip weekends.

---

## 3. Tick Normalization

Normalize every protobuf feed into:

```ts
interface Tick {
  instrumentKey: string;
  ts: number;            // exchange ltt if present, else receive time
  ltp: number;
  ltq?: number;
  volume?: number;       // cumulative day volume
  oi?: number;
  bidPrice?: number; bidQty?: number;
  askPrice?: number; askQty?: number;
  depth?: { bids: Level[]; asks: Level[] };  // top 5
  iv?: number; delta?: number; theta?: number; vega?: number; // if greeks present
}
```

Handle: duplicate ticks (same ltt+ltp+volume → drop), out-of-order timestamps
(tolerate small skew, log large skew), and the known V3 quirk where only
`market_info` frames arrive (treat as degraded feed → alert + reconnect attempt).

---

## 4. Rolling Window State (Redis)

Per instrument, maintain in Redis:

- `win:{key}:1s` — last 300 one-second aggregates (ring buffer via list or
  sorted set): {o,h,l,c, tickVol (volume delta), oiDelta, vwapNum, vwapDen,
  bidAskImbalance}
- Baselines (for z-scores): rolling mean/std of 1s tickVol and 1s |return|
  over the trailing 300s, updated incrementally (Welford). Exclude the first
  5 minutes after open from baselines or use wider std floors — opening ticks
  will otherwise poison the z-scores.
- All keys TTL 1 hour past market close.

The 1s aggregation job runs on a 1s interval per active instrument, pulling
new ticks from the Redis stream since the last consumed ID (consumer group).

---

## 5. Momentum Signal Components

Compute every second, per option instrument. Each component returns a value,
a z-score or normalized score in [-1, +1], and raw evidence.

1. **Premium velocity** — log-return of option LTP over 5s and 30s windows,
   normalized by trailing 300s return volatility. Captures "the premium is
   moving fast relative to its own recent behavior."
2. **Premium acceleration** — change in 5s velocity vs previous 5s. Positive
   acceleration + positive velocity = building momentum; decaying = fading.
3. **Volume burst** — z-score of current 5s traded volume vs 300s baseline.
   Cap at ±6 to prevent single-print blowouts.
4. **OI delta rate** — OI change over 60s. Classify jointly with price:
   price↑ + OI↑ = long buildup; price↑ + OI↓ = short covering; price↓ + OI↑ =
   short buildup; price↓ + OI↓ = long unwinding. (Descriptive labels only.)
5. **Order-flow imbalance** — from top-5 depth: (Σbid qty − Σask qty)/(Σbid+Σask),
   smoothed EMA over 10s. Also track bid/ask spread widening (momentum with a
   blowing-out spread is lower quality — penalize). When the instrument is in
   the D30 focus pool (§12.8), the imbalance becomes DISTANCE-WEIGHTED over
   the 30-level book: w_i = exp(−λ·i) per level i, so size parked far from
   the touch counts far less than size at the touch. On promotion mid-episode
   the imbalance smoother restarts (D5 and D30 EMA states are never mixed).
6. **Underlying confirmation** — same velocity computation on the index. For a
   CE, positive underlying velocity confirms; for a PE, negative confirms.
   Confirmation multiplier in [0.5, 1.5].
7. **IV shift (if greeks available)** — 60s IV change. Distinguishes directional
   momentum (premium up, IV flat, underlying moving) from vol events (premium
   up, IV spiking, underlying flat). Label the signal type accordingly.
8. **VWAP deviation** — distance of LTP from session VWAP in units of 30s ATR.
   Context feature, not a trigger.

### Composite score

```
score = 100 × σ( w1·velocity + w2·acceleration + w3·volBurst
               + w4·flowImbalance ) × underlyingConfirmation × spreadPenalty
```

- Weights in config (`config/momentum.yaml`), defaults: 0.35/0.15/0.30/0.20.
- Direction = sign of velocity. Score is magnitude 0–100.
- Signal classification enum: `DIRECTIONAL_BUILD`, `DIRECTIONAL_FADE`,
  `VOL_EVENT`, `SHORT_COVERING`, `LONG_UNWIND`, `NOISE` — derived from the
  component pattern table above.

### Event emission rules

- Emit `MomentumEvent` when score crosses a threshold (default 70) upward AND
  minimum liquidity gate passes (5s volume > floor, spread < ceiling).
- Hysteresis: after emission, no re-emission for the same instrument until
  score drops below 50 (prevents alert spam) — plus a hard 60s cooldown.
- Emit `MomentumDecay` when a previously alerted instrument drops below 40.

---

## 6. Persistence (PostgreSQL, Prisma)

Tables:

- `bar_1s` (instrument_key, ts, o, h, l, c, vol, oi, bid, ask, iv) — partitioned
  by day; a retention job drops partitions older than 30 days. (If write volume
  is a problem, downsample to 1s bars only for instruments in an "active" state
  and 1m bars otherwise.)
- `momentum_event` (id, ts, instrument_key, underlying, direction, score,
  classification, evidence JSONB, decayed_at)
- `session_stats` (per instrument per day: event count, max score, etc.)
- `feed_health` (connect/disconnect/reconnect log, tick-rate samples)

All raw tick history is NOT stored in v1 (volume too high) — 1s bars are the
canonical record. But add a config flag `recordTicks: true` that appends raw
ticks to daily NDJSON files under `data/ticks/` for replay (see §8).

---

## 7. API + Dashboard

### NestJS endpoints
- `GET /universe` — active instruments + subscription state
- `GET /events?from=&to=&underlying=` — historical momentum events
- `GET /instrument/:key/bars?window=` — 1s bars for charting
- `WS /live` — pushes: 1s snapshot per watched instrument (score, components),
  MomentumEvent, MomentumDecay, feed-health status

### Next.js dashboard (single page, dark theme consistent with the existing app)
1. **Heat grid** — strikes × {CE, PE} matrix per underlying, cells colored by
   live momentum score, click to expand.
2. **Live event tape** — reverse-chron feed of MomentumEvents with the full
   evidence breakdown (each component's value + z-score) — the evidence IS the
   product; make it prominent.
3. **Instrument drill-down** — 1s candle chart (lightweight-charts) with volume,
   OI subplot, score line overlay, and event markers.
4. **Feed health strip** — connection state, tick rate, last-tick age,
   subscription count.

Descriptive language everywhere: "High momentum observed", "Momentum fading",
"Long buildup pattern". Add a persistent footer: "Analytical tool. Displays
observed market data patterns only. Not investment advice."

---

## 8. Replay & Validation Mode

- `pnpm engine:replay --file data/ticks/2026-07-01.ndjson --speed 10`
- Replays recorded ticks through the exact same pipeline (feed handler swapped
  for a file reader behind a common `TickSource` interface).
- Used to tune weights/thresholds against known market days and to write
  deterministic integration tests (commit one small anonymized sample file).
- Output: summary report of events emitted, score distribution, would-have-
  fired counts at alternative thresholds.

---

## 9. Resilience & Ops

- Access token: Upstox tokens expire daily — provide a small auth helper route
  for the morning OAuth dance; store token in Redis; engine refuses to start
  the feed without a valid token and surfaces this on the dashboard.
- Reconnect: exponential backoff (1s → 30s cap), resubscribe full universe,
  mark a `gap` flag on 1s bars spanning the outage so momentum baselines
  restart cleanly (don't compute z-scores across a gap).
- Clock: use exchange `ltt` for bar bucketing; monitor drift between ltt and
  local clock.
- Structured logging (pino), metrics counters (ticks/sec, decode errors,
  events emitted), `/health` endpoint.
- Docker compose: engine, web, postgres, redis. `.env.example` with all knobs.

---

## 10. Testing

- Unit: indicator math (velocity, Welford baselines, imbalance, classification
  table) with fixture tick sequences — including gap, duplicate, out-of-order
  cases.
- Integration: replay a recorded sample file, assert exact set of events.
- Compliance test: grep-based test asserting no prescriptive vocabulary
  (buy/sell/entry/target/stoploss) exists in UI strings or alert templates.

## 11. Build Order

1. Scaffold + protobuf decode + feed handler with reconnect (log ticks).
2. Redis stream + 1s aggregation + baselines.
3. Momentum components + composite + event rules (unit tests first).
4. Momentum lifecycle + decay engine (§14) — unit tests with synthetic episodes.
5. Persistence + API.
6. Dashboard (heat grid + tape first, drill-down chart second, lifecycle states).
7. Replay mode + compliance test.
8. Historical data layer + 1-minute backtester (§13) — can be built in parallel
   with stages 1–7 since it shares only `packages/shared` indicator math.
9. Run the one-year backtest, produce the evaluation report, tune thresholds.

Deliver each stage runnable. Start with NIFTY weekly ATM ± 5 strikes only,
then widen.

---

## 12. Upstox Integration (complete wire-level detail)

### 12.1 Environment

```
UPSTOX_API_KEY=
UPSTOX_API_SECRET=
UPSTOX_REDIRECT_URI=http://localhost:3001/auth/upstox/callback
```

The user has already created an app in the Upstox Developer Console with the
redirect URI above. Never log the secret or token.

### 12.2 Daily auth helper (NestJS `AuthModule`)

Upstox access tokens expire early the next morning and cannot be refreshed
headlessly — a human logs in once per day. Implement:

- `GET /auth/login` → 302 redirect to:
  `https://api.upstox.com/v2/login/authorization/dialog?client_id={KEY}&redirect_uri={URI}&response_type=code`
- `GET /auth/upstox/callback?code=...` →
  `POST https://api.upstox.com/v2/login/authorization/token`
  Content-Type: `application/x-www-form-urlencoded`
  Body: `code, client_id, client_secret, redirect_uri, grant_type=authorization_code`
  → store `access_token` in Redis key `upstox:token` (TTL until 03:30 IST next
  day), then render a minimal "Authenticated — engine starting" page.
- `GET /auth/status` → { authenticated: boolean, expiresAt }
- Engine startup: if no valid token, do NOT connect the feed; set feed-health
  state `AWAITING_AUTH`; dashboard shows a "Login required" banner linking to
  `/auth/login`. Poll Redis; auto-start the feed the moment a token appears.

Example token exchange:

```ts
const res = await fetch('https://api.upstox.com/v2/login/authorization/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: KEY, client_secret: SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }),
});
const { access_token } = await res.json();
```

### 12.3 Instruments master → instrument keys

- Daily job (08:45 IST, and on demand): download
  `https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz`,
  gunzip, parse.
- Filter: `segment === 'NSE_FO'`, `instrument_type in ('CE','PE')`,
  underlying in universe, nearest weekly expiry, strikes within ATM ± N
  (ATM from previous close of the underlying index; index keys are
  `NSE_INDEX|Nifty 50`, `NSE_INDEX|Nifty Bank`).
- Cache the resolved universe (instrument_key, strike, type, expiry, lot size)
  in Postgres table `instrument_universe` + Redis for hot lookup.
- Verify field names against the actual downloaded file at implementation
  time — do not trust memory of the schema.
- BSE underlyings (SENSEX) download `BSE.json.gz` and keep `segment ===
  'BSE_FO'` instead; the per-exchange download+merge is driven by each
  underlying's `exchange` config field — see §12.8b.

### 12.4 Feed connection (V3 WebSocket)

Two-step handshake: the endpoint responds with a redirect to the authorized
socket, so the client MUST follow redirects.

```ts
import WebSocket from 'ws';

const ws = new WebSocket('wss://api.upstox.com/v3/feed/market-data-feed', {
  headers: { Authorization: `Bearer ${token}` },
  followRedirects: true,
});
```

Subscription messages are sent as BINARY frames (Buffer), never text:

```ts
ws.on('open', () => {
  ws.send(Buffer.from(JSON.stringify({
    guid: 'momentum-scan',
    method: 'sub',
    data: { mode: 'full', instrumentKeys: keys },
  })));
});
```

- `method`: `sub` | `change_mode` | `unsub` (use sub/unsub diffs for intraday
  ATM re-centering, §2).
- Modes used: `full` for options and underlying; optionally `option_greeks`
  as a second category if available on the account — feature-flag the IV
  component (§5.7) off when greeks are absent.
- Respect limits: single category up to 5000 keys; when two categories are
  active the per-category limit drops (e.g., 2000 each). Log subscription
  counts at startup and refuse to exceed limits.

### 12.5 Protobuf decode

- Download `MarketDataFeedV3.proto` from the Upstox developer docs and commit
  it to `packages/shared/proto/`. Generate/load with `protobufjs`.
- Every binary message decodes to `FeedResponse`; relevant shape:
  `{ type, feeds: { [instrumentKey]: { fullFeed | ltpc | firstLevelWithGreeks ... } }, currentTs }`
- `type === 'market_info'` frames carry segment status — record market open/
  close state; they are NOT tick data.
- Decode errors: count metric, log first occurrence per session, drop frame.

### 12.6 Known failure modes (handle explicitly)

1. **Connected but only `market_info`, no ticks** — almost always a
   subscription sent as text instead of binary, or a bad instrument key.
   Feed-health monitor (§9) detects tick starvation (connected >20s during
   market hours with 0 data frames) → resubscribe once → if still starved,
   full reconnect → if still starved, surface `TICK_STARVED` on dashboard.
2. **HTTP 403 on connect** — token expired or concurrent-connection limit
   hit (standard accounts: 1 connection; Upstox Plus: up to 5). Enforce a
   single feed connection in-process; on 403, set `AWAITING_AUTH` and prompt
   re-login rather than hammering reconnects (max 3 attempts then stop).
3. **Ping/pong** — the server sends standard ping frames when idle; `ws`
   auto-pongs. Do not treat idle-with-pings as starvation outside market
   hours.

### 12.7 Compliance reminder for this section

The Upstox integration is market-data only. Do not import or call any order
APIs (`/v2/order/**`, `/v3/order/**`). Add an ESLint restriction or grep test
that fails the build if order endpoints appear in the codebase.

---

## 13. One-Year Historical Backtest (Track A) + Tick Forward-Validation (Track B)

### 13.0 Fidelity statement (put this verbatim in the report header)

Tick-level history is not available from Upstox. Track A backtests the
momentum logic at 1-MINUTE resolution using the Expired Instruments APIs.
Components requiring live depth (order-flow imbalance §5.5, spread penalty)
are EXCLUDED in Track A; composite weights are renormalized over the
remaining components. Track A validates the concept and thresholds; Track B
(live tick recording + replay, §8) validates the full second-level engine
going forward. Results from Track A must not be read as guarantees of the
tick engine's behavior.

### 13.1 Historical data layer (`apps/engine/src/history`)

APIs (all require Upstox Plus; standard auth):
- `GET /v2/expired-instruments/expiries?instrument_key=...` → expiry dates
- `GET /v2/expired-instruments/option/contract?instrument_key=...&expiry_date=...`
  → expired contracts + `expired_instrument_key` (format
  `NSE_FO|{token}|{DD-MM-YYYY}`)
- `GET /v2/expired-instruments/historical-candle/{expired_instrument_key}/1minute/{to}/{from}`
  → 1-min OHLC + volume + OI
- Underlying index: Historical Candle Data V3, `minutes/1` interval for
  NIFTY/BANKNIFTY over the same year. Verify 1-min availability window in the
  V3 docs at implementation time (V2 limited 1-min to ~1 month; V3 extends it —
  if index 1-min doesn't cover the full year, fall back to computing underlying
  confirmation from the ATM-strike synthetic or from futures expired contracts).

Downloader requirements:
- **Strike selection per day**: from index daily OHLC, compute each session's
  ATM; download only ATM ± N (default 6) CE/PE of the nearest weekly expiry for
  that session. This bounds volume (~26 contracts/underlying/day ≈ 3.7M
  1-min rows per underlying per year — fine for Postgres).
- Rate-limit aware queue (configurable req/sec), exponential backoff on 429.
- Resumable: checkpoint table `hist_download_progress` (contract, status);
  idempotent re-runs skip completed contracts.
- Data-quality checks: empty-candle responses (a known issue for some
  expiries — log to `hist_gaps`, exclude those sessions from evaluation
  rather than silently producing zero signals), duplicate timestamps,
  sessions with <300 candles.
- Storage: `bar_1m_hist` (expired_instrument_key, ts, o,h,l,c, vol, oi),
  partitioned by month.

### 13.2 Signal adaptation at 1-minute resolution

Same math from `packages/shared`, re-windowed. Window mapping (config
`config/backtest.yaml`):

| Live (tick engine) | Backtest (1-min) |
|---|---|
| 5s velocity | 1-candle return |
| 30s velocity | 3-candle return |
| 300s baseline | 30-candle rolling baseline |
| 5s volume burst | 1-candle volume z vs 30-candle baseline |
| 60s OI delta | 3-candle OI delta |
| flow imbalance | EXCLUDED |
| spread penalty | EXCLUDED (apply a static liquidity gate: min candle volume) |
| underlying confirmation | same, from index 1-min |
| IV shift | EXCLUDED unless greeks derivable; skip in v1 |

Renormalize composite weights over available components. Keep the emission
rules (threshold, hysteresis, cooldown) structurally identical, thresholds
separately configurable for the 1-min variant.

### 13.3 Backtest runner

- `pnpm backtest --from 2025-07-01 --to 2026-06-30 --underlying NIFTY --config config/backtest.yaml`
- Streams `bar_1m_hist` chronologically per session through the same
  momentum + lifecycle (§14) code paths. STRICT no-lookahead: state at candle
  t uses only candles ≤ t; unit-test this with a poisoned-future fixture.
- Warm-up: first 30 candles of each session build baselines, no emissions.
- Emits `momentum_event_bt` and `momentum_episode_bt` tables mirroring live
  schemas plus forward-outcome columns (below).
- Parameter sweep mode: grid over threshold ∈ {60,65,70,75,80}, weight sets,
  window mappings — output one summary row per combination. Guard against
  overfitting: sweep on months 1–9, hold out months 10–12 untouched until a
  final single run.

### 13.4 Evaluation report (descriptive analytics)

For every emitted event, compute forward outcomes of the option premium at
+1, +3, +5, +10, +15 minutes: forward return, MFE (max favorable excursion,
in signal direction), MAE (max adverse excursion), and time-to-peak.
Report (HTML + JSON under `reports/`):

1. Event counts by underlying / moneyness bucket / time-of-day / month.
2. Forward-return distributions per horizon vs a matched random-baseline
   sample (same instruments, random timestamps, same liquidity gate) —
   the entire question is whether signal forward-returns dominate baseline.
3. Hit rate: fraction of events where MFE ≥ k× MAE within 10 min (k=1,2).
4. By-classification breakdown (DIRECTIONAL_BUILD vs SHORT_COVERING etc.).
5. Episode analytics (§14): distribution of episode duration, peak score,
   and DECAY CAPTURE: premium at FADING signal ÷ peak premium (giveback %).
6. Regime slices: expiry-day vs other days; first hour vs midday vs last hour;
   high-VIX vs low-VIX months if India VIX daily data is added.
7. Stability: month-by-month metric table — a signal that only worked in two
   months is a red flag; say so in the report template.

Report language stays descriptive ("events were followed by...", "the
distribution of forward returns was..."). No recommendation text.

### 13.5 Track B — forward tick validation

From the first live day, `recordTicks: true` (§6) is ON. Weekly job replays
accumulated tick files through the FULL engine (all components) and produces
the same evaluation report. After ~4 weeks, compare Track A (1-min, 1 year)
vs Track B (tick, 4+ weeks): if Track B event quality is materially worse,
the depth/flow components or tick-scale thresholds need retuning before the
signals are relied upon.

---

## 14. Momentum Lifecycle & Decay Engine ("when momentum is dying")

Replace the simple decay rule in §5 (score<40) with an episode state machine.
Runs identically in live (1s steps) and backtest (1m steps, re-windowed).

### 14.1 Episode lifecycle

An `Episode` opens when a MomentumEvent fires and tracks:

```ts
interface Episode {
  id: string; instrumentKey: string; direction: 1 | -1;
  openedAt: number; state: 'BUILDING'|'PEAK'|'FADING'|'DEAD';
  ignition: { score: number; vol5s: number; velocity: number };
  peak: { score: number; premiumExtreme: number; ts: number };  // running
  decayScore: number;   // 0–100, computed each step
  history: StepSnapshot[]; // ring buffer for evidence
}
```

### 14.2 Decay score components (each normalized to [0,1], weighted)

1. **Acceleration reversal** (w=0.25): consecutive steps with acceleration
   (§5.2) opposite to direction. 0 at 0 steps, 1 at ≥5 steps (live) / ≥3
   candles (backtest).
2. **Volume fade** (w=0.20): current window volume ÷ ignition window volume.
   1.0 when ratio ≤ 0.3; 0 when ≥ 1.0. Momentum without participation is
   momentum ending.
3. **Extreme stall** (w=0.20): seconds since premium last made a new extreme
   in the direction, ÷ stall budget (default 45s live / 4 candles backtest),
   capped at 1.
4. **Pullback depth** (w=0.15): retracement from premiumExtreme ÷ (k × 30s ATR),
   k default 1.5, capped at 1.
5. **Flow flip** (w=0.10, live only; weight renormalized in backtest):
   order-flow imbalance sign opposite to direction for ≥ 10s (EMA).
6. **Underlying divergence** (w=0.10): option premium flat/against while
   underlying confirmation multiplier has dropped below 1.0 — the underlying
   stopped cooperating.

`decayScore = 100 × Σ wᵢ·cᵢ` (renormalize weights for unavailable components).

### 14.3 State transitions & emitted events

- BUILDING → PEAK: score stops making new highs for `peakConfirmSteps`
  (default 10s / 2 candles) while score still ≥ 50.
- PEAK → FADING: decayScore crosses 50 upward → emit **`MomentumFading`**
  (the "dying" signal) with evidence: which components triggered, giveback so
  far, episode age. Hysteresis: revert FADING → PEAK only if decayScore < 30
  AND score makes a new episode high (re-ignition), which also emits
  `MomentumReignited`.
- FADING → DEAD: decayScore ≥ 75, OR composite score < 35, OR hard timeout
  (episode age > `maxEpisodeSec`, default 900s) → emit **`MomentumDead`**
  with final episode summary (duration, peak score, total premium range,
  giveback %). Episode closes; instrument re-enters normal scanning after
  the §5 cooldown.
- Persist every state change in `momentum_episode` (+ `_bt` twin).

### 14.4 Surfacing

- Dashboard: heat-grid cells show a lifecycle glyph (▲ building, ● peak,
  ▼ fading, ✕ dead); event tape carries MomentumFading/Dead with the same
  evidence-first layout; drill-down chart shades the episode span and marks
  state transitions.
- WS `/live` pushes lifecycle transitions as first-class messages.
- Alert copy (descriptive): "Momentum fading — volume 0.4x ignition,
  no new high for 52s, acceleration negative 6 steps."

### 14.5 Decay-specific tests

- Synthetic episode fixtures: clean impulse-then-fade, V-reversal,
  re-ignition, slow bleed, one-print spike — assert exact state sequences.
- Backtest metric (feeds report §13.4.5): median giveback at MomentumFading
  must be materially below giveback at the naive score<40 rule; include both
  in the report for comparison.

### 12.8 D30 Focus Pool (Upstox Plus)

Upstox Plus provides up to 5 concurrent V3 WebSocket connections and a
`full_d30` subscription mode carrying 30-level market depth, limited to 50
instruments per connection. Plus does NOT change tick latency or frequency —
same feed, wider payload. This section uses it to sharpen decay observation.

**Connection topology.** One ConnectionManager owns N named connections:

- **Connection A — broad universe**: `full` mode (5-level depth), all ATM±N
  options + indices. This is the pre-Plus behavior, unchanged.
- **Connection B — focus pool**: `full_d30` mode, max 50 slots, dedicated to
  instruments with OPEN episodes (§14).

Each connection has independent reconnect/backoff/starvation state; the
feed-health strip shows both, plus pool occupancy ("focus 12/50").

**Promotion.** When a MomentumEvent opens an episode, subscribe that
instrument on Connection B in `full_d30`. While pooled, its ticks are taken
from B (A's duplicates for that key are ignored); its flow components use
the distance-weighted D30 imbalance (§5.5). All other instruments continue
on D5 via A.

**Demotion.** On MomentumDead + cooldown expiry, unsubscribe from B and fall
back to A's D5 ticks.

**Overflow (>50 open episodes).** Evict the episode with the lowest current
composite score — but NEVER evict FADING episodes ahead of BUILDING ones:
decay observation has priority, it is the reason the pool exists. (PEAK
ranks with BUILDING for eviction purposes; only FADING is protected.)

**EMA hygiene.** A promotion or demotion switches the depth basis (5↔30
levels). The flow-imbalance smoother must restart at the switch — never mix
D5 and D30 EMA states; the first 10s after a switch are a warming period
during which the flow component reports unavailable.

**Graceful degradation.** Everything is behind `focusPool.enabled`
(config/momentum.yaml). With the flag off, or when the account lacks Plus,
or when Connection B fails its reconnect ladder, the system degrades to
D5-only operation identical to pre-Plus behavior. Connection B failures
must never take down Connection A.

### 12.8b Multi-exchange underlyings (NSE + BSE / SENSEX)

NIFTY and BANKNIFTY are NSE index options (segment `NSE_FO`); SENSEX is a
BSE index option (segment `BSE_FO`). The pipeline is exchange-agnostic — the
only exchange-specific input is *which instruments master to download and
which segment to keep*. This is driven entirely by config, not code:

- **Config.** Each `underlyings[]` entry in `config/universe.yaml` carries an
  `exchange: NSE | BSE` field (zod-validated, default `NSE`). SENSEX is
  registered with `indexInstrumentKey: "BSE_INDEX|SENSEX"`, `strikeStep: 100`,
  `exchange: BSE`.
- **Instruments master.** `UniverseService.loadMaster` downloads one master
  per *distinct* configured exchange and merges them:
  `NSE.json.gz` → keep `segment === 'NSE_FO'`; `BSE.json.gz` → keep
  `segment === 'BSE_FO'`. `parseMasterRow(row, segment)` filters to the
  requested segment so the two dumps never cross-contaminate. Only exchanges
  the universe actually uses are fetched.
- **Selection, feed, downloader.** ATM ± N selection, subscription diffs, the
  WebSocket feed, and the historical downloader all key off
  `indexInstrumentKey` + `strikeStep` and pass instrument keys through
  verbatim — no NSE assumption remains. The Expired Instruments API is called
  with the BSE index key for SENSEX exactly as with the NSE key for NIFTY.

**Verify at first BSE run (do not trust memory):**
1. BSE.json.gz uses `segment === 'BSE_FO'` and the SENSEX underlying symbol is
   literally `"SENSEX"` (confirm against a fresh dump; adjust the config
   `symbol` / master field mapping if it differs).
2. The Expired Instruments API serves BSE expired option contracts and 1m
   candles for `BSE_INDEX|SENSEX` (Upstox Plus). If BSE expired data is not
   served, the SENSEX *backtest* cannot run even though live scanning can.
3. The V3 feed accepts `BSE_INDEX|SENSEX` and its `BSE_FO|...` option keys in
   the same `sub` frame; watch the startup subscription-count log.
