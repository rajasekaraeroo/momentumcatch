import pino from "pino";
import type { LoggerService } from "@nestjs/common";

/**
 * Root structured logger (SPEC §9). Pretty-printed in dev, JSON otherwise.
 * Decoded ticks are logged through children of this instance, so Stage 1
 * acceptance ("ticks logging to stdout") and production logging share a path.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production" || process.env.LOG_JSON === "true"
      ? undefined
      : { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l" } },
});

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ mod: name });
}

/** Adapter so NestJS framework logs flow through pino too. */
export class PinoNestLogger implements LoggerService {
  private readonly inner = createLogger("nest");

  log(message: unknown, ctx?: string): void {
    this.inner.info({ ctx }, String(message));
  }
  error(message: unknown, trace?: string, ctx?: string): void {
    this.inner.error({ ctx, trace }, String(message));
  }
  warn(message: unknown, ctx?: string): void {
    this.inner.warn({ ctx }, String(message));
  }
  debug(message: unknown, ctx?: string): void {
    this.inner.debug({ ctx }, String(message));
  }
  verbose(message: unknown, ctx?: string): void {
    this.inner.debug({ ctx }, String(message));
  }
}
