import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/** config/backtest.yaml (SPEC §13.2) — zod-validated, fail fast. */
export const backtestConfigSchema = z.object({
  windows: z.object({
    fastCandles: z.number().int().positive(),
    slowCandles: z.number().int().positive(),
    oiCandles: z.number().int().positive(),
    baselineCandles: z.number().int().positive(),
    warmupCandles: z.number().int().positive(),
  }),
  weights: z.object({
    velocity: z.number().nonnegative(),
    acceleration: z.number().nonnegative(),
    volumeBurst: z.number().nonnegative(),
  }),
  liquidityGate: z.object({ minCandleVolume: z.number().nonnegative() }),
  emission: z.object({
    scoreThreshold: z.number().min(0).max(100),
    rearmBelow: z.number().min(0).max(100),
    cooldownCandles: z.number().int().nonnegative(),
  }),
  lifecycle: z.object({
    accelReversalCandlesFull: z.number().int().positive(),
    stallBudgetCandles: z.number().int().positive(),
    peakConfirmCandles: z.number().int().positive(),
  }),
  download: z.object({
    atmRange: z.number().int().positive(),
    requestsPerSecond: z.number().positive(),
    interval: z.string(),
  }),
  evaluation: z.object({
    horizonsMin: z.array(z.number().int().positive()),
    mfeMaeK: z.array(z.number().positive()),
    tuneMonths: z.number().int().positive(),
    randomBaselinePerEvent: z.number().int().positive(),
  }),
});
export type BacktestConfig = z.infer<typeof backtestConfigSchema>;

export function loadBacktestConfig(repoRoot: string, file = "config/backtest.yaml"): BacktestConfig {
  const raw = fs.readFileSync(path.join(repoRoot, file), "utf8");
  return backtestConfigSchema.parse(YAML.parse(raw));
}
