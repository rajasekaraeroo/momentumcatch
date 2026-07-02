import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { AppConfigModule } from "./config/config.module";
import { FeedModule } from "./feed/feed.module";
import { HealthModule } from "./health/health.module";
import { RedisModule } from "./redis/redis.module";

@Module({
  imports: [AppConfigModule, RedisModule, AuthModule, FeedModule, HealthModule],
})
export class AppModule {}
