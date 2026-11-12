import "reflect-metadata";
import type { NextFunction, Request, Response } from "express";
import { NestFactory } from "@nestjs/core";
import { installBodyParsers } from "./http/body-parsers";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { controlPlaneConfigFromEnv } from "@agent-in-box/config";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./http/api-exception.filter";
import { ConsoleService } from "./vms/console.service";
import { EventsService } from "./events/events.service";
import { attachUpgradeFallback } from "./http/upgrade-fallback";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

async function bootstrap(): Promise<void> {
  const config = controlPlaneConfigFromEnv();
  if (!LOOPBACK_HOSTS.has(config.host)) {
    throw new Error(
      `CONTROL_PLANE_HOST=${config.host} 不是回环地址。阶段 11 的本地 Web 只允许本机访问；远程访问必须通过后续单独实现并授权的加密 Relay。`,
    );
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The inbox upload route streams the File itself. Nest's global parser
    // would consume an application/json upload before the controller can read
    // the request, storing a 0-byte file. Register parsers manually and skip
    // that one route.
    bodyParser: false,
  });
  installBodyParsers(app);

  // No CORS: Web and Electron always use the same origin. A malicious page on
  // another local port therefore cannot read responses or send custom headers.
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
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    if (request.path.startsWith("/api/")) {
      response.setHeader("Cache-Control", "no-store");
    }
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
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
          "object-src 'none'",
          "form-action 'self'",
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
