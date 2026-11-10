import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { controlPlaneConfigFromEnv } from "@agent-in-box/config";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const config = controlPlaneConfigFromEnv();
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  console.log(`control-plane listening on http://${config.host}:${config.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error("control-plane failed to start", error);
  process.exitCode = 1;
});
