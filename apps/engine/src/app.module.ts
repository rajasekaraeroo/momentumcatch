import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { AppConfigModule } from "./config/config.module";
import { FeedModule } from "./feed/feed.module";
import { HealthModule } from "./health/health.module";
import { MomentumModule } from "./momentum/momentum.module";
import { RedisModule } from "./redis/redis.module";
import { StreamsModule } from "./streams/streams.module";

@Module({
  imports: [
    AppConfigModule,
    RedisModule,
    StreamsModule,
    AuthModule,
    FeedModule,
    MomentumModule,
    HealthModule,
  ],
})
export class AppModule {}
