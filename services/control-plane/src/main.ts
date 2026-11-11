import "reflect-metadata";
import type { NextFunction, Request, Response } from "express";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { controlPlaneConfigFromEnv } from "@agent-in-box/config";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./http/api-exception.filter";
import { ConsoleService } from "./vms/console.service";
import { EventsService } from "./events/events.service";
import { attachUpgradeFallback } from "./http/upgrade-fallback";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

async function bootstrap(): Promise<void> {
  const config = controlPlaneConfigFromEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });
  app.useGlobalFilters(new ApiExceptionFilter());

  // DNS-rebinding guard: loopback-only services should not answer arbitrary
  // Host headers from a malicious local web page.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const hostname = request.hostname;
    if (hostname && !ALLOWED_HOSTNAMES.has(hostname)) {
      response.status(403).json({
        ok: false,
        error: { code: "forbidden", message: "Host 不被允许" },
      });
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const webRoot = process.env.AGENT_IN_BOX_WEB_ROOT?.trim();
  if (webRoot) {
    // Register security headers before serving static files; Express static
    // responds without calling next(), so later middleware would not apply.
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
      next();
    });
    app.useStaticAssets(webRoot, { index: "index.html" });
  }

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  const httpServer = app.getHttpServer();
  const detachConsole = app.get(ConsoleService).attach(httpServer);
  httpServer.once("close", detachConsole);
  const detachEvents = app.get(EventsService).attach(httpServer);
  httpServer.once("close", detachEvents);
  const detachUpgradeFallback = attachUpgradeFallback(httpServer);
  httpServer.once("close", detachUpgradeFallback);
  console.log(`control-plane listening on http://${config.host}:${config.port}`);
}

bootstrap().catch((error: unknown) => {
  console.error("control-plane failed to start", error);
  process.exitCode = 1;
});
