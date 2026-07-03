import { z } from "zod";

/**
 * Zod schemas for config/*.yaml and .env (CLAUDE.md: validate at startup,
 * fail fast on invalid config).
 */

const istTime = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "expected HH:MM (IST)");

export const universeConfigSchema = z.object({
  underlyings: z
    .array(
      z.object({
        symbol: z.string().min(1),
        indexInstrumentKey: z.string().min(1),
        strikeStep: z.number().positive(),
        atmRange: z.number().int().positive(),
        /** which exchange this underlying's options + instruments master
         *  live on: NSE (NIFTY/BANKNIFTY, NSE_FO) or BSE (SENSEX, BSE_FO) */
        exchange: z.enum(["NSE", "BSE"]).default("NSE"),
      }),
    )
    .min(1),
  expiry: z.object({
    select: z.literal("nearest_weekly"),
    rollCutoffIst: istTime,
  }),
  recentering: z.object({
    driftStrikesThreshold: z.number().int().positive(),
  }),
  schedule: z.object({
    connectIst: istTime,
    disconnectIst: istTime,
    holidaysFile: z.string().min(1),
  }),
});
export type UniverseConfig = z.infer<typeof universeConfigSchema>;

export const momentumConfigSchema = z.object({
  windows: z.object({
    fastSec: z.number().int().positive(),
    slowSec: z.number().int().positive(),
    oiSec: z.number().int().positive(),
    baselineSec: z.number().int().positive(),
    openExclusionSec: z.number().int().nonnegative(),
  }),
  weights: z.object({
    velocity: z.number().nonnegative(),
    acceleration: z.number().nonnegative(),
    volumeBurst: z.number().nonnegative(),
    flowImbalance: z.number().nonnegative(),
  }),
  caps: z.object({ volumeBurstZ: z.number().positive() }),
  floors: z.object({
    retVol: z.number().positive(),
    volStd: z.number().nonnegative(),
  }),
  underlyingConfirmation: z.object({ min: z.number(), max: z.number() }),
  liquidityGate: z.object({
    minVol5s: z.number().nonnegative(),
    maxSpreadPct: z.number().positive(),
  }),
  emission: z.object({
    scoreThreshold: z.number().min(0).max(100),
    rearmBelow: z.number().min(0).max(100),
    cooldownSec: z.number().nonnegative(),
  }),
  lifecycle: z.object({
    decayWeights: z.object({
      accelerationReversal: z.number().nonnegative(),
      volumeFade: z.number().nonnegative(),
      extremeStall: z.number().nonnegative(),
      pullbackDepth: z.number().nonnegative(),
      flowFlip: z.number().nonnegative(),
      underlyingDivergence: z.number().nonnegative(),
    }),
    accelReversalStepsFull: z.number().int().positive(),
    volumeFadeFloorRatio: z.number().positive(),
    stallBudgetSec: z.number().positive(),
    flowFlipStepsFull: z.number().int().positive(),
    pullbackAtrK: z.number().positive(),
    peakConfirmSteps: z.number().int().positive(),
    fadingAt: z.number().min(0).max(100),
    reigniteBelow: z.number().min(0).max(100),
    deadAt: z.number().min(0).max(100),
    deadScoreFloor: z.number().min(0).max(100),
    maxEpisodeSec: z.number().positive(),
  }),
  focusPool: z.object({
    enabled: z.boolean(),
    capacity: z.number().int().positive().max(50),
    demotionCooldownSec: z.number().nonnegative(),
    imbalanceLambda: z.number().nonnegative(),
    emaWarmupSec: z.number().int().nonnegative(),
  }),
});
export type MomentumConfig = z.infer<typeof momentumConfigSchema>;

/** { "_comment"?: string, "2026": ["2026-01-26", ...] } */
export const holidaysSchema = z
  .record(z.union([z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), z.string()]))
  .transform((rec) => {
    const dates = new Set<string>();
    for (const [key, value] of Object.entries(rec)) {
      if (key.startsWith("_") || typeof value === "string") continue;
      for (const d of value) dates.add(d);
    }
    return dates;
  });

export const envSchema = z.object({
  UPSTOX_API_KEY: z.string().default(""),
  UPSTOX_API_SECRET: z.string().default(""),
  UPSTOX_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3001/auth/upstox/callback"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_URL: z.string().default(""),
  ENGINE_PORT: z.coerce.number().int().positive().default(3001),
  RECORD_TICKS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** dev/test escape hatch: connect the feed outside market hours */
  FEED_IGNORE_MARKET_HOURS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** dev/test override of subscription keys (comma-separated) */
  FEED_KEYS: z.string().default(""),
  /** test-only: register synthetic options "key=CE|PE=underlyingIndexKey,..."
   *  so replay/injected streams exercise the full momentum pipeline */
  SYNTH_OPTION_KEYS: z.string().default(""),
});
export type EnvConfig = z.infer<typeof envSchema>;
