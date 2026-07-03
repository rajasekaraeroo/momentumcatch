import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { envSchema } from "./config/schema";
import { createLogger, PinoNestLogger } from "./logger";

async function bootstrap(): Promise<void> {
  const log = createLogger("main");
  const app = await NestFactory.create(AppModule, {
    logger: new PinoNestLogger(),
  });
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: true }); // dashboard on :3000 talks to engine on :3001
  const port = envSchema.parse(process.env).ENGINE_PORT;
  await app.listen(port);
  log.info({ port }, "engine listening");
}

bootstrap().catch((err) => {
  // Fail fast (CLAUDE.md): invalid config or boot errors kill the process.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
