import { Global, Module, type OnApplicationShutdown, Inject } from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";

export const REDIS = Symbol("REDIS");

const log = createLogger("redis");

function createRedis(config: AppConfigService): Redis {
  // Feed startup polls for the auth token, so the engine must boot (and serve
  // /health + /auth) even while Redis is still coming up — retry forever with
  // a capped delay instead of crashing.
  const client = new Redis(config.env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    // Fail commands immediately while disconnected instead of queueing them —
    // /health and the feed's token poll must never block on a down Redis.
    enableOfflineQueue: false,
    connectTimeout: 3_000,
    retryStrategy: (times) => Math.min(1000 * 2 ** Math.min(times, 5), 30_000),
  });
  let reportedDown = false;
  client.on("error", (err) => {
    if (!reportedDown) {
      log.warn({ err: err.message }, "redis unavailable — retrying with backoff");
      reportedDown = true;
    }
  });
  client.on("ready", () => {
    reportedDown = false;
    log.info("redis connected");
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfigService],
      useFactory: createRedis,
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}
