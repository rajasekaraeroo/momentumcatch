import { Module } from "@nestjs/common";
import { ApiModule } from "./api/api.module";
import { AlertsModule } from "./alerts/alerts.module";
import { AuthModule } from "./auth/auth.module";
import { AppConfigModule } from "./config/config.module";
import { DbModule } from "./db/db.module";
import { FeedModule } from "./feed/feed.module";
import { HealthModule } from "./health/health.module";
import { LifecycleModule } from "./lifecycle/lifecycle.module";
import { MomentumModule } from "./momentum/momentum.module";
import { PersistenceModule } from "./persistence/persistence.module";
import { RedisModule } from "./redis/redis.module";
import { SignalsModule } from "./signals/signals.module";
import { StreamsModule } from "./streams/streams.module";
import { UniverseModule } from "./universe/universe.module";

@Module({
  imports: [
    AppConfigModule,
    RedisModule,
    DbModule,
    StreamsModule,
    SignalsModule,
    UniverseModule,
    AuthModule,
    FeedModule,
    MomentumModule,
    LifecycleModule,
    PersistenceModule,
    AlertsModule,
    ApiModule,
    HealthModule,
  ],
})
export class AppModule {}
