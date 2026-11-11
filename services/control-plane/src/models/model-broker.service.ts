import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { ModelRequestRecord, ModelRequestUsage } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import type { ModelCredentialProvider } from "./credential-provider";
import { MODEL_CREDENTIAL_PROVIDER } from "./tokens";
import { ModelProviderService } from "./model-provider.service";
import { ModelTokenService, type ModelTokenContext } from "./model-token.service";

export const MODEL_BROKER_OPTIONS = Symbol("AGENT_IN_BOX_MODEL_BROKER_OPTIONS");

export interface ModelBrokerOptions {
  host?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

interface RequestState {
  id: string;
  token: ModelTokenContext;
  startedAt: number;
  attempts: number;
  upstreamStatus: number | null;
  usage: ModelRequestUsage | null;
}

@Injectable()
export class ModelBrokerService implements OnModuleInit, OnModuleDestroy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeByToken = new Map<string, number>();
  private readonly recentRequests = new Map<string, number[]>();
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private listening = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tokens: ModelTokenService,
    private readonly providers: ModelProviderService,
    @Inject(MODEL_CREDENTIAL_PROVIDER) private readonly credentials: ModelCredentialProvider,
    @Optional() @Inject(MODEL_BROKER_OPTIONS) options: ModelBrokerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    // QEMU user networking maps guest 10.0.2.2 to the host loopback, so the
    // broker does not need a LAN-facing listener.
    this.host = options.host ?? process.env.AGENT_IN_BOX_MODEL_BROKER_HOST?.trim() ?? "127.0.0.1";
    this.requestedPort = options.port ?? readPort(process.env.AGENT_IN_BOX_MODEL_BROKER_PORT, 6719);
    this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
    this.maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 2));
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(async (error: unknown) => {
        await this.writeUnhandledError(response, error);
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
    for (const controller of this.activeControllers) controller.abort();
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

  async listRequests(
    filters: { workerId?: string; taskId?: string; limit?: number } = {},
  ): Promise<ModelRequestRecord[]> {
    let query = this.db
      .selectFrom("model_requests")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(200, filters.limit ?? 50)));
    if (filters.workerId) query = query.where("worker_id", "=", filters.workerId);
    if (filters.taskId) query = query.where("task_id", "=", filters.taskId);
    const rows = await query.execute();
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      model: row.model,
      workerId: row.worker_id,
      taskId: row.task_id,
      status: row.status as ModelRequestRecord["status"],
      upstreamStatus: row.upstream_status,
      attempts: row.attempts,
      durationMs: row.duration_ms,
      usage: row.usage_json ? (JSON.parse(row.usage_json) as ModelRequestUsage) : null,
      errorCode: row.error_code,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, { status: "ok", service: "model-broker" });
      return;
    }
    if (!validHost(request.headers.host)) {
      this.json(response, 403, errorBody("forbidden", "Model Broker Host 不被允许"));
      return;
    }
    const endpoint = endpointFor(url.pathname);
    if (request.method !== "POST" || !endpoint) {
      this.json(response, 404, errorBody("not_found", "Model Broker route not found"));
      return;
    }
    const token = await this.tokens.authenticate(bearer(request.headers.authorization));
    this.checkRateLimit(token.id);
    const active = (this.activeByToken.get(token.id) ?? 0) + 1;
    if (active > 2) {
      this.json(response, 429, errorBody("rate_limited", "该 Worker 的并发模型请求已达上限"));
      return;
    }
    this.activeByToken.set(token.id, active);
    try {
      await this.proxy(token, endpoint, request, response);
    } finally {
      const remaining = Math.max(0, (this.activeByToken.get(token.id) ?? 1) - 1);
      if (remaining === 0) this.activeByToken.delete(token.id);
      else this.activeByToken.set(token.id, remaining);
    }
  }

  private async proxy(
    token: ModelTokenContext,
    endpoint: "chat/completions" | "messages",
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readRequest(request, this.maxBodyBytes);
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (parsed.model !== token.model) {
      throw new PersistenceError("forbidden", "请求模型不在该短期令牌的允许范围内");
    }
    const { provider } = await this.providers.resolve(token.providerId, token.model);
    if (
      (provider.api === "openai-completions" && endpoint !== "chat/completions") ||
      (provider.api === "anthropic-messages" && endpoint !== "messages")
    ) {
      throw new PersistenceError("bad_request", "Provider API 与请求端点不匹配");
    }
    if (token.taskId) await this.assertTaskActive(token);
    const secret = await this.credentials.getSecret(provider.credentialProviderId);
    const state: RequestState = {
      id: randomUUID(),
      token,
      startedAt: Date.now(),
      attempts: 0,
      upstreamStatus: null,
      usage: null,
    };
    await this.db
      .insertInto("model_requests")
      .values({
        id: state.id,
        token_id: token.id,
        provider_id: provider.id,
        model: token.model,
        worker_id: token.workerId,
        task_id: token.taskId,
        vm_id: token.vmId,
        status: "started",
        upstream_status: null,
        attempts: 1,
        duration_ms: null,
        usage_json: null,
        error_code: null,
        created_at: nowIso(),
        completed_at: null,
      })
      .execute();

    let abortReason = "";
    const controllers = new Set<AbortController>();
    const abort = (reason: string): void => {
      if (!abortReason) abortReason = reason;
      for (const controller of controllers) controller.abort();
    };
    const removeRevocationListener = await this.tokens.onRevoke(token.id, () => abort("revoked"));
    const onClientClose = (): void => {
      if (!response.writableEnded) abort("client_disconnected");
    };
    response.on("close", onClientClose);
    const timeout = setTimeout(() => abort("timeout"), this.requestTimeoutMs);
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        state.attempts = attempt;
        const controller = new AbortController();
        controllers.add(controller);
        this.activeControllers.add(controller);
        let upstream: Response;
        try {
          const headers: Record<string, string> = {
            accept: headerString(request.headers.accept) ?? "application/json",
            "content-type": "application/json",
            ...(provider.api === "openai-completions"
              ? { authorization: `Bearer ${secret}` }
              : {
                  "x-api-key": secret,
                  "anthropic-version":
                    headerString(request.headers["anthropic-version"]) ?? "2023-06-01",
                }),
          };
          const beta = headerString(request.headers["anthropic-beta"]);
          if (beta) headers["anthropic-beta"] = beta;
          upstream = await this.fetchImpl(`${provider.baseUrl}/${endpoint}`, {
            method: "POST",
            headers,
            body: new Uint8Array(body),
            redirect: "error",
            signal: controller.signal,
          });
        } catch (error) {
          if (abortReason) throw new BrokerAbortError(abortReason);
          if (attempt >= this.maxAttempts) {
            await this.finish(state, "failed", "provider_connection_error");
            throw new PersistenceError(
              "unavailable",
              `模型 Provider 连接失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }

        state.upstreamStatus = upstream.status;
        if (retryableStatus(upstream.status) && attempt < this.maxAttempts) {
          await upstream.body?.cancel();
          continue;
        }
        if (!upstream.ok) {
          await this.finish(state, "failed", `provider_http_${upstream.status}`);
          await this.forwardBuffered(upstream, response, 4 * 1024 * 1024);
          return;
        }

        const contentType = upstream.headers.get("content-type") ?? "application/json";
        response.writeHead(upstream.status, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        if (contentType.includes("text/event-stream")) {
          if (!upstream.body) throw new PersistenceError("unavailable", "Provider 流式响应为空");
          const tap = new UsageTap((usage) => {
            state.usage = mergeUsage(state.usage, usage);
          });
          try {
            await pipeline(
              Readable.fromWeb(
                upstream.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
              ),
              tap,
              response,
            );
            await this.finish(state, tap.providerError ? "failed" : "completed", tap.providerError);
          } catch (error) {
            if (abortReason) {
              await this.finish(state, terminalAbortStatus(abortReason), `request_${abortReason}`);
              response.destroy();
              return;
            }
            await this.finish(state, "failed", "provider_stream_interrupted");
            throw error;
          }
        } else {
          const bytes = await readWebStream(upstream.body, 32 * 1024 * 1024);
          state.usage = usageFromPayload(
            JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
          );
          response.end(Buffer.from(bytes));
          await this.finish(state, "completed", null);
        }
        return;
      }
      throw new PersistenceError("unavailable", "模型 Provider 重试后仍不可用");
    } catch (error) {
      if (error instanceof BrokerAbortError) {
        await this.finish(state, terminalAbortStatus(error.reason), `request_${error.reason}`);
        if (!response.headersSent) {
          const status = error.reason === "revoked" ? 401 : error.reason === "timeout" ? 504 : 499;
          this.json(
            response,
            status,
            errorBody(`request_${error.reason}`, abortMessage(error.reason)),
          );
        } else {
          response.destroy();
        }
        return;
      }
      if (!response.headersSent) {
        await this.finish(state, "failed", "broker_request_failed");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      response.off("close", onClientClose);
      removeRevocationListener();
      for (const controller of controllers) this.activeControllers.delete(controller);
      controllers.clear();
    }
  }

  private async forwardBuffered(
    upstream: Response,
    response: ServerResponse,
    limit: number,
  ): Promise<void> {
    const bytes = await readWebStream(upstream.body, limit);
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    });
    response.end(Buffer.from(bytes));
  }

  private async finish(
    state: RequestState,
    status: string,
    errorCode: string | null,
  ): Promise<void> {
    const completedAt = nowIso();
    await this.db
      .updateTable("model_requests")
      .set({
        status,
        upstream_status: state.upstreamStatus,
        attempts: state.attempts,
        duration_ms: Math.max(0, Date.now() - state.startedAt),
        usage_json: state.usage ? JSON.stringify(state.usage) : null,
        error_code: errorCode,
        completed_at: completedAt,
      })
      .where("id", "=", state.id)
      .execute();
  }

  private async assertTaskActive(token: ModelTokenContext): Promise<void> {
    const task = await this.db
      .selectFrom("tasks")
      .select(["status", "vm_id", "assigned_worker_id"])
      .where("id", "=", token.taskId!)
      .executeTakeFirst();
    if (
      !task ||
      task.vm_id !== token.vmId ||
      task.assigned_worker_id !== token.workerId ||
      (task.status !== "running" && task.status !== "waiting_approval")
    ) {
      throw new PersistenceError("conflict", "短期令牌绑定的任务已不在该 Worker 上执行");
    }
  }

  private checkRateLimit(tokenId: string): void {
    const now = Date.now();
    const recent = (this.recentRequests.get(tokenId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 60) {
      throw new PersistenceError("rate_limited", "该 Worker 的模型请求频率已达上限");
    }
    recent.push(now);
    this.recentRequests.set(tokenId, recent);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private async writeUnhandledError(response: ServerResponse, error: unknown): Promise<void> {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const persistence = error instanceof PersistenceError ? error : null;
    const status = persistence
      ? persistence.code === "unauthorized"
        ? 401
        : persistence.code === "forbidden"
          ? 403
          : persistence.code === "not_found"
            ? 404
            : persistence.code === "conflict"
              ? 409
              : persistence.code === "rate_limited"
                ? 429
                : persistence.code === "unavailable"
                  ? 503
                  : 400
      : 500;
    const message =
      error instanceof SyntaxError
        ? "请求 JSON 无效"
        : error instanceof Error
          ? error.message
          : String(error);
    this.json(
      response,
      status,
      errorBody(persistence?.code ?? "internal_error", message.slice(0, 1000)),
    );
  }
}

class UsageTap extends Transform {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  providerError: string | null = null;

  constructor(private readonly onUsage: (usage: ModelRequestUsage) => void) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    callback(null, chunk);
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      this.parseEvent(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-4096);
  }

  private parseEvent(block: string): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as { type?: string; usage?: unknown; error?: unknown };
      if (parsed.type === "error" || parsed.error) this.providerError = "provider_stream_error";
      const usage = usageFromPayload(parsed);
      if (usage) this.onUsage(usage);
    } catch {
      // The byte stream is forwarded unchanged; malformed Provider SSE is not
      // rewritten into a synthetic success or logged with model content.
    }
  }
}

class BrokerAbortError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function usageFromPayload(payload: unknown): ModelRequestUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const value = usage as Record<string, unknown>;
  const promptDetails = value.prompt_tokens_details as Record<string, unknown> | undefined;
  const result: ModelRequestUsage = {
    inputTokens: numberOrNull(value.input_tokens ?? value.prompt_tokens),
    outputTokens: numberOrNull(value.output_tokens ?? value.completion_tokens),
    cacheReadInputTokens: numberOrNull(
      value.cache_read_input_tokens ?? promptDetails?.cached_tokens,
    ),
    cacheCreationInputTokens: numberOrNull(value.cache_creation_input_tokens),
  };
  return Object.values(result).some((entry) => entry !== null) ? result : null;
}

function mergeUsage(left: ModelRequestUsage | null, right: ModelRequestUsage): ModelRequestUsage {
  return {
    inputTokens: right.inputTokens ?? left?.inputTokens ?? null,
    outputTokens: right.outputTokens ?? left?.outputTokens ?? null,
    cacheReadInputTokens: right.cacheReadInputTokens ?? left?.cacheReadInputTokens ?? null,
    cacheCreationInputTokens:
      right.cacheCreationInputTokens ?? left?.cacheCreationInputTokens ?? null,
  };
}

async function readRequest(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new PersistenceError("bad_request", "模型请求超过大小上限");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new PersistenceError("bad_request", "模型请求超过大小上限");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readWebStream(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PersistenceError("unavailable", "Provider 响应超过大小上限");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function endpointFor(pathname: string): "chat/completions" | "messages" | null {
  if (pathname === "/v1/chat/completions") return "chat/completions";
  if (pathname === "/v1/messages") return "messages";
  return null;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(value: string | undefined): string {
  if (!value?.startsWith("Bearer ")) throw new PersistenceError("unauthorized", "缺少 Broker 令牌");
  return value.slice(7);
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

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

function terminalAbortStatus(reason: string): "cancelled" | "failed" {
  return reason === "timeout" ? "failed" : "cancelled";
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function abortMessage(reason: string): string {
  switch (reason) {
    case "revoked":
      return "Model Broker 令牌已撤销";
    case "timeout":
      return "模型请求超时";
    default:
      return "模型请求已取消";
  }
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid AGENT_IN_BOX_MODEL_BROKER_PORT: ${raw}`);
  }
  return value;
}
