import { Global, Module } from "@nestjs/common";
import { InstrumentRegistry } from "./instrument-registry";
import { UniverseService } from "./universe.service";

@Global()
@Module({
  providers: [InstrumentRegistry, UniverseService],
  exports: [InstrumentRegistry, UniverseService],
})
export class UniverseModule {}
