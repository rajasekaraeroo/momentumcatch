import { Global, Module } from "@nestjs/common";
import { SignalBus } from "./signal-bus";

@Global()
@Module({
  providers: [SignalBus],
  exports: [SignalBus],
})
export class SignalsModule {}
