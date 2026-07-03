import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FocusPoolModule } from "../focus-pool/focus-pool.module";
import { FeedService } from "./feed.service";

@Module({
  imports: [AuthModule, FocusPoolModule],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
