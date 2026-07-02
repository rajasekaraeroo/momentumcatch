import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FeedService } from "./feed.service";

@Module({
  imports: [AuthModule],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
