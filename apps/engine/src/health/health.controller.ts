import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";
import { AuthService } from "../auth/auth.service";
import { FeedService } from "../feed/feed.service";
import { AggregationService } from "../momentum/aggregation.service";
import { REDIS } from "../redis/redis.module";

/** /health — feed state, metrics counters, auth + redis status (SPEC §9). */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(FeedService) private readonly feed: FeedService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AggregationService) private readonly aggregation: AggregationService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async health(): Promise<Record<string, unknown>> {
    const redisUp = await this.redis
      .ping()
      .then(() => true)
      .catch(() => false);
    return {
      status: "ok",
      feed: this.feed.getStatus(),
      aggregation: this.aggregation.getStatus(),
      auth: await this.auth.status(),
      redis: redisUp ? "up" : "down",
    };
  }
}
