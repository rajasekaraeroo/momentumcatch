import { Global, Module } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../redis/redis.module";
import { RedisTickStream, TICK_STREAM } from "./tick-stream";

@Global()
@Module({
  providers: [
    {
      provide: TICK_STREAM,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RedisTickStream(redis),
    },
  ],
  exports: [TICK_STREAM],
})
export class StreamsModule {}
