import { Module } from "@nestjs/common";
import { FeedModule } from "../feed/feed.module";
import { LifecycleModule } from "../lifecycle/lifecycle.module";
import { MomentumModule } from "../momentum/momentum.module";
import { ApiController } from "./api.controller";
import { LiveGateway } from "./live.gateway";

@Module({
  imports: [FeedModule, MomentumModule, LifecycleModule],
  controllers: [ApiController],
  providers: [LiveGateway],
})
export class ApiModule {}
