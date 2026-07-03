import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FeedModule } from "../feed/feed.module";
import { MomentumModule } from "../momentum/momentum.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [FeedModule, AuthModule, MomentumModule],
  controllers: [HealthController],
})
export class HealthModule {}
