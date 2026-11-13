import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { CuaCompleteRequest } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { CuaExecutionService, type CuaActionInput } from "./cua-execution.service";
import { CuaTokenService } from "./cua-token.service";

export const CUA_BROKER_OPTIONS = Symbol("AGENT_IN_BOX_CUA_BROKER_OPTIONS");

export interface CuaBrokerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

@Injectable()
export class CuaBrokerService implements OnModuleInit, OnModuleDestroy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private listening = false;

  constructor(
    private readonly tokens: CuaTokenService,
    private readonly execution: CuaExecutionService,
    @Optional() @Inject(CUA_BROKER_OPTIONS) options: CuaBrokerOptions = {},
  ) {
    this.host = options.host ?? process.env.AGENT_IN_BOX_CUA_BROKER_HOST?.trim() ?? "127.0.0.1";
    this.requestedPort = options.port ?? readPort(process.env.AGENT_IN_BOX_CUA_BROKER_PORT, 6720);
    this.maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.writeError(response, error);
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async onModuleInit(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.listening = true;
  }

  async onModuleDestroy(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.listening = false;
    }
  }

  get port(): number {
    const address = this.server.address();
    return address && typeof address === "object"
      ? (address as AddressInfo).port
      : this.requestedPort;
  }

  guestBaseUrl(): string {
    const override = process.env.AGENT_IN_BOX_CUA_BROKER_GUEST_URL?.trim();
    return override || `http://10.0.2.2:${this.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, { status: "ok", service: "cua-broker" });
      return;
    }
    if (!validHost(request.headers.host)) {
      this.json(response, 403, errorBody("forbidden", "Computer Use Broker Host 不被允许"));
      return;
    }
    if (request.method !== "POST") {
      this.json(response, 404, errorBody("not_found", "Computer Use Broker route not found"));
      return;
    }
    const token = await this.tokens.authenticate(bearer(request.headers.authorization));
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abort.abort();
    });

    if (url.pathname === "/v1/observe") {
      const body = await this.body(request);
      const observation = await this.execution.observe(token, {
        ...(typeof body.actionId === "string" ? { actionId: body.actionId } : {}),
      });
      this.json(response, 200, {
        ok: true,
        taskId: observation.taskId,
        screenshotId: observation.screenshotId,
        width: observation.width,
        height: observation.height,
        dpi: observation.dpi,
        scaleFactor: observation.scaleFactor,
        sha256: observation.sha256,
        image: { mimeType: "image/png", dataBase64: observation.dataBase64 },
      });
      return;
    }
    if (url.pathname === "/v1/actions") {
      const body = await this.body(request);
      const input = actionInput(body);
      const result = await this.execution.act(token, input, abort.signal);
      this.json(response, 200, {
        ok: true,
        taskId: result.taskId,
        actionId: result.actionId,
        status: result.status,
        screenshotId: result.screenshotId,
        image: {
          mimeType: "image/png",
          dataBase64: result.afterScreenshot.dataBase64,
        },
        display: {
          width: result.afterScreenshot.width,
          height: result.afterScreenshot.height,
          dpi: result.afterScreenshot.dpi,
          scaleFactor: result.afterScreenshot.scaleFactor,
        },
      });
      return;
    }
    if (url.pathname === "/v1/human-verifications") {
      const body = await this.body(request);
      const result = await this.execution.requestHumanVerification(token, {
        reason: typeof body.reason === "string" ? body.reason : "",
        screenshotId: typeof body.screenshotId === "string" ? body.screenshotId : "",
      });
      this.json(response, 200, { ok: true, verification: result, taskStatus: "waiting_human" });
      return;
    }
    if (url.pathname === "/v1/complete") {
      const body = await this.body(request);
      const result = await this.execution.complete(token, completionInput(body));
      this.json(response, 200, { ok: true, ...result });
      return;
    }
    this.json(response, 404, errorBody("not_found", "Computer Use Broker route not found"));
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > this.maxBodyBytes) {
        throw new PersistenceError("validation_failed", "Computer Use 请求体过大");
      }
      chunks.push(buffer);
    }
    if (total === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new PersistenceError("bad_request", "Computer Use 请求体必须是 JSON 对象");
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private writeError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof PersistenceError) {
      this.json(response, statusFor(error.code), {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.json(response, 500, errorBody("internal_error", message.slice(0, 2000)));
  }
}

function actionInput(body: Record<string, unknown>): CuaActionInput {
  if (typeof body.action !== "object" || body.action === null) {
    throw new PersistenceError("validation_failed", "action 必须是对象");
  }
  return {
    action: body.action as CuaActionInput["action"],
    ...(typeof body.screenshotId === "string" ? { screenshotId: body.screenshotId } : {}),
    ...(typeof body.actionId === "string" ? { actionId: body.actionId } : {}),
    ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
  };
}

function completionInput(body: Record<string, unknown>): CuaCompleteRequest {
  return {
    summary: typeof body.summary === "string" ? body.summary : "",
    evidence: Array.isArray(body.evidence) ? (body.evidence as CuaCompleteRequest["evidence"]) : [],
  };
}

function bearer(value: string | undefined): string {
  const prefix = "Bearer ";
  return typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : "";
}

function validHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1", "10.0.2.2"].includes(hostname);
  } catch {
    return false;
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "lease_conflict":
    case "idempotency_conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "unavailable":
      return 503;
    case "validation_failed":
    case "bad_request":
      return 400;
    default:
      return 500;
  }
}

function errorBody(code: string, message: string): unknown {
  return { ok: false, error: { code, message } };
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Computer Use Broker port: ${raw}`);
  }
  return port;
}
