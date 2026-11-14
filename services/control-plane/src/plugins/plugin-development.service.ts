import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { PluginService } from "./plugin.service";

export const PLUGIN_DEVELOPMENT_OPTIONS = Symbol("AGENT_IN_BOX_PLUGIN_DEVELOPMENT_OPTIONS");

export interface PluginDevelopmentOptions {
  port?: number;
  tokenTtlMs?: number;
}

export interface PluginDevelopmentContext {
  id: string;
  workerId: string;
  projectId: string;
  autoEnable: boolean;
}

interface TransferFile {
  path: string;
  dataBase64: string;
}

@Injectable()
export class PluginDevelopmentService implements OnModuleInit, OnModuleDestroy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly requestedPort: number;
  private readonly tokenTtlMs: number;
  private listening = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly plugins: PluginService,
    @Optional() @Inject(PLUGIN_DEVELOPMENT_OPTIONS) options: PluginDevelopmentOptions = {},
  ) {
    this.requestedPort = options.port ?? readPort(process.env.AGENT_IN_BOX_PLUGIN_DEV_PORT, 6723);
    this.tokenTtlMs = Math.max(60_000, options.tokenTtlMs ?? 8 * 60 * 60_000);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) =>
        this.writeError(response, error),
      );
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.requestTimeout = 30_000;
  }

  async onModuleInit(): Promise<void> {
    await this.db
      .updateTable("plugin_development_tokens")
      .set({ revoked_at: nowIso() })
      .where("revoked_at", "is", null)
      .execute();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, "127.0.0.1", () => {
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
    return process.env.AGENT_IN_BOX_PLUGIN_DEV_GUEST_URL?.trim() || `http://10.0.2.2:${this.port}`;
  }

  async issue(input: {
    workerId: string;
    projectId: string;
    autoEnable: boolean;
  }): Promise<{ token: string; context: PluginDevelopmentContext }> {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await this.db
      .insertInto("plugin_development_tokens")
      .values({
        id,
        token_hash: hash(token),
        worker_id: input.workerId,
        project_id: input.projectId,
        auto_enable: input.autoEnable ? 1 : 0,
        expires_at: new Date(Date.now() + this.tokenTtlMs).toISOString(),
        revoked_at: null,
        created_at: nowIso(),
        last_used_at: null,
      })
      .execute();
    return {
      token,
      context: {
        id,
        workerId: input.workerId,
        projectId: input.projectId,
        autoEnable: input.autoEnable,
      },
    };
  }

  async revokeWorker(workerId: string): Promise<void> {
    await this.db
      .updateTable("plugin_development_tokens")
      .set({ revoked_at: nowIso() })
      .where("worker_id", "=", workerId)
      .where("revoked_at", "is", null)
      .execute();
  }

  private async authenticate(request: IncomingMessage): Promise<PluginDevelopmentContext> {
    const token = bearer(request.headers.authorization);
    if (!token || token.length > 256)
      throw new PersistenceError("unauthorized", "插件开发令牌无效");
    const row = await this.db
      .selectFrom("plugin_development_tokens")
      .selectAll()
      .where("token_hash", "=", hash(token))
      .executeTakeFirst();
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new PersistenceError("unauthorized", "插件开发令牌无效、过期或已撤销");
    }
    await this.db
      .updateTable("plugin_development_tokens")
      .set({ last_used_at: nowIso() })
      .where("id", "=", row.id)
      .execute();
    return {
      id: row.id,
      workerId: row.worker_id,
      projectId: row.project_id,
      autoEnable: row.auto_enable === 1,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, { status: "ok", service: "plugin-development-broker" });
      return;
    }
    if (!validHost(request.headers.host) || request.method !== "POST") {
      this.json(response, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
      return;
    }
    const context = await this.authenticate(request);
    const body = await this.body(request);
    if (url.pathname === "/v1/inspect") {
      const result = await this.plugins.inspectTransferredPackage(transferFiles(body.files));
      this.json(response, 200, { ok: true, ...result });
      return;
    }
    if (url.pathname === "/v1/register") {
      const report = body.testReport;
      if (typeof report !== "object" || report === null || Array.isArray(report)) {
        throw new PersistenceError("validation_failed", "插件测试记录必须是对象");
      }
      const result = await this.plugins.registerTransferredPackage(
        transferFiles(body.files),
        report as Record<string, unknown>,
      );
      this.json(response, 200, {
        ok: true,
        plugin: result,
        autoEnableAllowed: context.autoEnable,
        projectId: context.projectId,
      });
      return;
    }
    if (url.pathname === "/v1/enable") {
      if (!context.autoEnable) {
        throw new PersistenceError(
          "forbidden",
          "当前 Development Worker 未获自动启用权限；插件已注册时可由用户在本机启用",
        );
      }
      if (typeof body.pluginId !== "string" || typeof body.version !== "string") {
        throw new PersistenceError("validation_failed", "插件启用需要 pluginId 和 version");
      }
      const result = await this.plugins.enable(body.pluginId, {
        version: body.version,
        scopeType: "project",
        scopeId: context.projectId,
      });
      this.json(response, 200, { ok: true, enablement: result });
      return;
    }
    this.json(response, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > 8 * 1024 * 1024) {
        throw new PersistenceError("validation_failed", "插件开发请求不能超过 8 MiB");
      }
      chunks.push(bytes);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new PersistenceError("validation_failed", "插件开发请求必须是 JSON 对象");
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
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "runtime_error")
        : "runtime_error";
    const status =
      code === "unauthorized"
        ? 401
        : code === "forbidden"
          ? 403
          : code === "conflict"
            ? 409
            : code === "validation_failed"
              ? 400
              : 500;
    this.json(response, status, {
      ok: false,
      error: {
        code,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      },
    });
  }
}

function transferFiles(value: unknown): TransferFile[] {
  if (!Array.isArray(value)) {
    throw new PersistenceError("validation_failed", "插件文件列表必须是数组");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new PersistenceError("validation_failed", "插件文件条目无效");
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.dataBase64 !== "string") {
      throw new PersistenceError("validation_failed", "插件文件需要 path 和 dataBase64");
    }
    return { path: file.path, dataBase64: file.dataBase64 };
  });
}

function bearer(value: string | undefined): string {
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
}

function validHost(value: string | undefined): boolean {
  if (!value) return false;
  const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "localhost", "::1", "10.0.2.2"].includes(hostname);
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("Invalid plugin development broker port");
  }
  return value;
}
