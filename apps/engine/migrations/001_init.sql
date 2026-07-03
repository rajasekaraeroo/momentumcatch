-- MomentumScan schema (SPEC §6, §13.1, §13.3). Timestamps are epoch ms
-- (bigint) to match the engine; partitions are created/dropped by the
-- PersistenceService (day partitions for bar_1s, month for bar_1m_hist).

-- §6 live 1s bars, partitioned by day; retention drops partitions > 30 days
CREATE TABLE IF NOT EXISTS bar_1s (
  instrument_key text        NOT NULL,
  ts             bigint      NOT NULL,
  o real NOT NULL, h real NOT NULL, l real NOT NULL, c real NOT NULL,
  vol real NOT NULL DEFAULT 0,
  oi_delta real NOT NULL DEFAULT 0,
  oi real,
  bid real, ask real, iv real,
  bid_ask_imbalance real,
  spread_pct real,
  gap boolean NOT NULL DEFAULT false,
  PRIMARY KEY (instrument_key, ts)
) PARTITION BY RANGE (ts);

-- §6 momentum events (live)
CREATE TABLE IF NOT EXISTS momentum_event (
  id             uuid PRIMARY KEY,
  ts             bigint NOT NULL,
  instrument_key text   NOT NULL,
  underlying     text,
  direction      smallint NOT NULL,
  score          real   NOT NULL,
  classification text   NOT NULL,
  evidence       jsonb  NOT NULL,
  episode_id     uuid,
  decayed_at     bigint
);
CREATE INDEX IF NOT EXISTS momentum_event_ts_idx ON momentum_event (ts);
CREATE INDEX IF NOT EXISTS momentum_event_underlying_idx ON momentum_event (underlying, ts);

-- §14.3 episode lifecycle (live)
CREATE TABLE IF NOT EXISTS momentum_episode (
  id              uuid PRIMARY KEY,
  instrument_key  text NOT NULL,
  underlying      text,
  direction       smallint NOT NULL,
  opened_at       bigint NOT NULL,
  closed_at       bigint,
  state           text NOT NULL,
  peak_score      real,
  premium_extreme real,
  ignition        jsonb NOT NULL,
  decay_evidence  jsonb,
  giveback_pct    real,
  fading_giveback real
);
CREATE INDEX IF NOT EXISTS momentum_episode_key_idx ON momentum_episode (instrument_key, opened_at);

-- §6 per-instrument per-day rollup
CREATE TABLE IF NOT EXISTS session_stats (
  session_date   date NOT NULL,
  instrument_key text NOT NULL,
  event_count    integer NOT NULL DEFAULT 0,
  max_score      real    NOT NULL DEFAULT 0,
  PRIMARY KEY (session_date, instrument_key)
);

-- §6 connect/disconnect/reconnect log + tick-rate samples
CREATE TABLE IF NOT EXISTS feed_health (
  id     bigserial PRIMARY KEY,
  ts     bigint NOT NULL,
  kind   text   NOT NULL,
  detail jsonb
);

-- §12.3 resolved option universe cache
CREATE TABLE IF NOT EXISTS instrument_universe (
  instrument_key text PRIMARY KEY,
  underlying     text NOT NULL,
  strike         real NOT NULL,
  side           smallint NOT NULL,
  expiry         date NOT NULL,
  lot_size       integer,
  resolved_at    bigint NOT NULL
);

-- ── §13 historical track ────────────────────────────────────────────────

-- 1-minute candles from the Expired Instruments APIs, partitioned by month
CREATE TABLE IF NOT EXISTS bar_1m_hist (
  expired_instrument_key text   NOT NULL,
  underlying             text   NOT NULL,
  strike                 real,
  side                   smallint,
  expiry                 date,
  ts                     bigint NOT NULL,
  o real NOT NULL, h real NOT NULL, l real NOT NULL, c real NOT NULL,
  vol real NOT NULL DEFAULT 0,
  oi  real,
  PRIMARY KEY (expired_instrument_key, ts)
) PARTITION BY RANGE (ts);

-- §13.1 resumable downloader checkpoints
CREATE TABLE IF NOT EXISTS hist_download_progress (
  contract_key text PRIMARY KEY,
  status       text NOT NULL,       -- pending | done | failed | empty
  detail       jsonb,
  updated_at   bigint NOT NULL
);

-- §13.1 data-quality exclusions
CREATE TABLE IF NOT EXISTS hist_gaps (
  expired_instrument_key text NOT NULL,
  session_date           date NOT NULL,
  reason                 text NOT NULL,
  PRIMARY KEY (expired_instrument_key, session_date, reason)
);

-- §13.3 backtest twins with forward-outcome columns
CREATE TABLE IF NOT EXISTS momentum_event_bt (
  id             uuid PRIMARY KEY,
  run_id         text   NOT NULL,
  ts             bigint NOT NULL,
  instrument_key text   NOT NULL,
  underlying     text,
  strike         real,
  side           smallint,
  moneyness      text,
  direction      smallint NOT NULL,
  score          real NOT NULL,
  classification text NOT NULL,
  evidence       jsonb NOT NULL,
  episode_id     uuid,
  is_baseline    boolean NOT NULL DEFAULT false, -- §13.4.2 random baseline rows
  fwd_returns    jsonb,   -- {"1": r, "3": r, "5": r, "10": r, "15": r}
  mfe            real,
  mae            real,
  time_to_peak_min real
);
CREATE INDEX IF NOT EXISTS momentum_event_bt_run_idx ON momentum_event_bt (run_id, ts);

CREATE TABLE IF NOT EXISTS momentum_episode_bt (
  id              uuid PRIMARY KEY,
  run_id          text NOT NULL,
  instrument_key  text NOT NULL,
  underlying      text,
  direction       smallint NOT NULL,
  opened_at       bigint NOT NULL,
  closed_at       bigint,
  state           text NOT NULL,
  peak_score      real,
  premium_extreme real,
  ignition        jsonb NOT NULL,
  decay_evidence  jsonb,
  giveback_pct    real,
  fading_giveback real,
  naive_giveback  real    -- giveback at the naive score<40 rule, for §14.5
);
CREATE INDEX IF NOT EXISTS momentum_episode_bt_run_idx ON momentum_episode_bt (run_id, opened_at);
