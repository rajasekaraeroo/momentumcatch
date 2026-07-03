import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import type Redis from "ioredis";
import { AppConfigService } from "../config/config.service";
import { REDIS } from "../redis/redis.module";
import { AggregationService } from "./aggregation.service";
import { BAR_STORE, RedisBarStore } from "./bar-store";
import { MomentumService } from "./momentum.service";

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: BAR_STORE,
      inject: [REDIS, AppConfigService],
      useFactory: (redis: Redis, config: AppConfigService) =>
        new RedisBarStore(redis, config.momentum.windows.baselineSec),
    },
    AggregationService,
    MomentumService,
  ],
  exports: [AggregationService, MomentumService],
})
export class MomentumModule {}
