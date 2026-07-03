import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";

export const PG = Symbol("PG");

const log = createLogger("db");

/**
 * PostgreSQL pool + idempotent SQL migrations (SPEC §6). Persistence is
 * best-effort: if the database is unreachable the engine keeps running
 * (detection > storage) and PersistenceService drops writes with a counter.
 */
export async function runMigrations(pool: Pool, engineDir: string): Promise<void> {
  const dir = path.join(engineDir, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  for (const file of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [
      file,
    ]);
    if (done.rowCount) continue;
    log.info({ file }, "applying migration");
    await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  }
}

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
  });
  pool.on("error", (err) => log.warn({ err: err.message }, "pg pool error"));
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG,
      inject: [AppConfigService],
      useFactory: async (config: AppConfigService): Promise<Pool | null> => {
        if (!config.env.DATABASE_URL) {
          log.warn("DATABASE_URL empty — persistence disabled");
          return null;
        }
        const pool = createPool(config.env.DATABASE_URL);
        try {
          await runMigrations(pool, path.join(config.repoRoot, "apps", "engine"));
          log.info("database ready");
          return pool;
        } catch (err) {
          log.error(
            { err: (err as Error).message },
            "database unavailable — persistence disabled, engine continues",
          );
          await pool.end().catch(() => undefined);
          return null;
        }
      },
    },
  ],
  exports: [PG],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG) private readonly pool: Pool | null) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
  }
}
