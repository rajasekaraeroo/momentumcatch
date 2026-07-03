import { Module } from "@nestjs/common";
import { LifecycleModule } from "../lifecycle/lifecycle.module";
import { MomentumModule } from "../momentum/momentum.module";
import { FocusPoolService } from "./focus-pool.service";

@Module({
  imports: [MomentumModule, LifecycleModule],
  providers: [FocusPoolService],
  exports: [FocusPoolService],
})
export class FocusPoolModule {}
