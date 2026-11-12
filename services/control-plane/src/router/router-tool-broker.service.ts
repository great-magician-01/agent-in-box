import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { RouterToolService } from "./router-tool.service";

export const ROUTER_BROKER_OPTIONS = Symbol("AGENT_IN_BOX_ROUTER_BROKER_OPTIONS");

export interface RouterBrokerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  now?: () => Date;
}

/**
 * Loopback-only tool broker used by the host Router Pi process. Every call is
 * authenticated by a short-lived Router tool token and persisted for audit.
 */
@Injectable()
export class RouterToolBrokerService implements OnModuleInit, OnModuleDestroy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => Date;
  private listening = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tools: RouterToolService,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(ROUTER_BROKER_OPTIONS) options: RouterBrokerOptions = {},
  ) {
    this.host = options.host ?? process.env.AGENT_IN_BOX_ROUTER_BROKER_HOST?.trim() ?? "127.0.0.1";
    this.requestedPort =
      options.port ?? readPort(process.env.AGENT_IN_BOX_ROUTER_BROKER_PORT, 6721);
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.now = options.now ?? (() => new Date());
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, { status: "ok", service: "router-tool-broker" });
      return;
    }
    if (!validHost(request.headers.host)) {
      this.json(response, 403, errorBody("forbidden", "Router Tool Broker Host 不被允许"));
      return;
    }
    let conversationId: string;
    try {
      conversationId = await this.authenticate(bearer(request.headers.authorization));
    } catch (error) {
      this.json(
        response,
        error instanceof PersistenceError ? 401 : 500,
        errorBody("unauthorized", "Router 工具令牌无效、过期或已撤销"),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tools") {
      this.json(response, 200, { ok: true, result: this.tools.definitions() });
      return;
    }
    const match = /^\/v1\/tools\/([a-z0-9_]{1,80})$/.exec(url.pathname);
    if (request.method !== "POST" || !match?.[1]) {
      this.json(response, 404, errorBody("not_found", "Router Tool Broker route not found"));
      return;
    }
    const toolName = match[1];
    const started = Date.now();
    const id = randomUUID();
    let args: Record<string, unknown> = {};
    try {
      args = await this.body(request);
      const rawToolCallId = request.headers["x-agent-in-box-tool-call-id"];
      const toolCallId = Array.isArray(rawToolCallId) ? rawToolCallId[0] : rawToolCallId;
      const result = await this.tools.execute(toolName, args, {
        conversationId,
        ...(typeof toolCallId === "string" &&
        toolCallId !== "" &&
        /^[A-Za-z0-9._:-]{1,200}$/.test(toolCallId)
          ? { toolCallId }
          : {}),
      });
      await this.audit({
        id,
        conversationId,
        toolName,
        args,
        result,
        status: "ok",
        errorCode: null,
        errorMessage: null,
        durationMs: Date.now() - started,
      });
      this.json(response, 200, { ok: true, result });
    } catch (error) {
      const code = error instanceof PersistenceError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      await this.audit({
        id,
        conversationId,
        toolName,
        args,
        result: null,
        status: "error",
        errorCode: code,
        errorMessage: message,
        durationMs: Date.now() - started,
      }).catch(() => undefined);
      this.writeError(response, error);
    }
  }

  private async authenticate(token: string): Promise<string> {
    if (!token || token.length > 256) {
      throw new PersistenceError("unauthorized", "Router 工具令牌缺失");
    }
    const row = await this.db
      .selectFrom("router_sessions")
      .select(["conversation_id", "status", "tool_token_expires_at"])
      .where("tool_token_hash", "=", hash(token))
      .executeTakeFirst();
    if (
      !row ||
      row.status !== "running" ||
      !row.tool_token_expires_at ||
      new Date(row.tool_token_expires_at).getTime() <= this.now().getTime()
    ) {
      throw new PersistenceError("unauthorized", "Router 工具令牌无效、过期或已撤销");
    }
    return row.conversation_id;
  }

  private async audit(input: {
    id: string;
    conversationId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    status: "ok" | "error";
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number;
  }): Promise<void> {
    const resultJson = safeJson(input.result);
    if (Buffer.byteLength(resultJson, "utf8") > 512 * 1024) {
      throw new PersistenceError("unavailable", "Router 工具结果过大，请缩小查询范围");
    }
    await this.db
      .insertInto("router_tool_calls")
      .values({
        id: input.id,
        conversation_id: input.conversationId,
        tool_name: input.toolName,
        args_json: capJson(input.args, 16 * 1024),
        result_json: input.result === null ? null : capJson(input.result, 512 * 1024),
        status: input.status,
        error_code: input.errorCode,
        error_message: input.errorMessage?.slice(0, 2000) ?? null,
        duration_ms: Math.max(0, input.durationMs),
        created_at: nowIso(),
      })
      .execute();
    await this.outbox.append(
      "router.tool_call",
      {
        conversationId: input.conversationId,
        toolName: input.toolName,
        status: input.status,
      },
      nowIso(),
    );
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > this.maxBodyBytes) {
        throw new PersistenceError("validation_failed", "Router 工具请求体过大");
      }
      chunks.push(buffer);
    }
    if (total === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new PersistenceError("validation_failed", "Router 工具请求体必须是 JSON 对象");
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
        error: { code: error.code, message: error.message },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.json(response, 500, errorBody("internal_error", message.slice(0, 2000)));
  }
}

function bearer(value: string | undefined): string {
  const prefix = "Bearer ";
  return typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : "";
}

function validHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(hostname);
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
      return 409;
    case "validation_failed":
    case "bad_request":
      return 400;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

function errorBody(code: string, message: string): unknown {
  return { ok: false, error: { code, message } };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

function capJson(value: unknown, limit: number): string {
  const json = safeJson(value);
  return json.length > limit
    ? JSON.stringify({ truncated: true, preview: json.slice(0, limit) })
    : json;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Router Tool Broker port: ${raw}`);
  }
  return port;
}
