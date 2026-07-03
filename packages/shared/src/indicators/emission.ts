/**
 * Event-emission rules (SPEC §5): emit when the score crosses `threshold`
 * upward AND the liquidity gate passes; then hold until the score drops
 * below `rearmBelow` AND a hard cooldown has elapsed. Structurally identical
 * for the live engine (seconds) and the backtester (candles) — `step` units
 * are whatever the caller's clock is.
 */
export interface EmissionConfig {
  threshold: number; // default 70
  rearmBelow: number; // default 50
  cooldownSteps: number; // 60 (live seconds) / 3 (backtest candles)
}

export type EmissionVerdict = "emit" | "hold";

export class EmissionGate {
  private armed = true;
  private lastEmitStep: number | null = null;

  constructor(private readonly cfg: EmissionConfig) {}

  /** Call once per step with the current score + gate status. */
  update(score: number, liquidityOk: boolean, step: number): EmissionVerdict {
    const cooledDown =
      this.lastEmitStep === null ||
      step - this.lastEmitStep >= this.cfg.cooldownSteps;
    if (!this.armed && score < this.cfg.rearmBelow) this.armed = true;
    if (this.armed && cooledDown && liquidityOk && score >= this.cfg.threshold) {
      this.armed = false;
      this.lastEmitStep = step;
      return "emit";
    }
    return "hold";
  }

  reset(): void {
    this.armed = true;
    this.lastEmitStep = null;
  }
}
