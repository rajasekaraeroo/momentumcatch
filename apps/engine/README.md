# apps/engine (NestJS)

Modules: feed/, momentum/, lifecycle/, alerts/, history/, backtest/, auth/, health/.
Alert copy lives ONLY in src/alerts/templates.ts (audited by scripts/compliance-check.sh).

## Status: SPEC §11 Stages 1–2 complete

Implemented: auth/ (daily OAuth, token in Redis), feed/ (Upstox V3 WebSocket
with redirect handshake, binary subscription frames, protobuf decode,
reconnect with exponential backoff, tick-starvation escalation, market-hours
scheduling, tick normalization + dedupe, fan-out to Redis Streams with gap
markers), streams/ (ticks:{key} bus behind an interface so feed and momentum
can split into separate processes), momentum/ (1s bar aggregation via
consumer group — OHLC/vol-delta/oiDelta/vwap/imbalance, carry-forward for
trade-less seconds, gap-aware Welford baselines with open exclusion, hot
window win:{key}:1s + baseline:{key} in Redis, TTL 1h past close), replay/
(NDJSON file replay behind `TickSource`, `--bars` aggregation mode),
health/ (/health with feed + aggregation state and counters).

Before the first live run:

1. `bash scripts/fetch-proto.sh` — downloads `MarketDataFeedV3.proto` into
   `packages/shared/proto/` (the feed refuses to start without it).
2. `cp .env.example .env` and fill in the Upstox credentials.
3. `docker compose up -d` (Redis holds the daily token).
4. `pnpm dev`, open `http://localhost:3001/auth/login`, complete the OAuth
   dance — the feed connects automatically during market hours.

Outside market hours, verify the pipeline with replay:

```bash
pnpm engine:replay --file apps/engine/test/fixtures/sample-ticks.ndjson --speed max
# aggregate to 1s bars + baselines instead of raw ticks:
pnpm engine:replay --file apps/engine/test/fixtures/sample-ticks.ndjson --speed max --bars
```

Stage 1 subscribes to the underlying index keys from `config/universe.yaml`;
option-universe resolution from the instruments master (SPEC §12.3) arrives
with Stage 2. `FEED_KEYS` (comma-separated) overrides the subscription list
for testing, `FEED_IGNORE_MARKET_HOURS=true` bypasses the schedule gate.
