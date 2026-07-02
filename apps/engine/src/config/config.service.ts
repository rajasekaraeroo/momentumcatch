import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import {
  envSchema,
  holidaysSchema,
  momentumConfigSchema,
  universeConfigSchema,
  type EnvConfig,
  type MomentumConfig,
  type UniverseConfig,
} from "./schema";

/** Walk up from cwd to the workspace root (marked by pnpm-workspace.yaml). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate repo root (pnpm-workspace.yaml) above ${start}`,
      );
    }
    dir = parent;
  }
}

function loadValidated<T>(
  file: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  parseYaml: boolean,
): T {
  const raw = fs.readFileSync(file, "utf8");
  const data: unknown = parseYaml ? YAML.parse(raw) : JSON.parse(raw);
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid config ${file}:\n${issues}`);
    }
    throw err;
  }
}

/**
 * Loads and validates all configuration once at startup; any invalid file or
 * env value throws before the app finishes bootstrapping (fail fast).
 */
@Injectable()
export class AppConfigService {
  readonly repoRoot: string;
  readonly env: EnvConfig;
  readonly universe: UniverseConfig;
  readonly momentum: MomentumConfig;
  readonly holidays: Set<string>;

  constructor() {
    this.repoRoot = findRepoRoot();
    const configDir = path.join(this.repoRoot, "config");
    this.env = envSchema.parse(process.env);
    this.universe = loadValidated(
      path.join(configDir, "universe.yaml"),
      universeConfigSchema,
      true,
    );
    this.momentum = loadValidated(
      path.join(configDir, "momentum.yaml"),
      momentumConfigSchema,
      true,
    );
    this.holidays = loadValidated(
      path.join(this.repoRoot, this.universe.schedule.holidaysFile),
      holidaysSchema,
      false,
    );
  }
}
