import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  PI_ENGINE_VERSION,
  PI_SESSION_FORMAT_VERSION,
  PiWorkerEngine,
  type WorkerEngine,
  type WorkerEngineEvent,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type {
  RouterMessageRecord,
  RouterSendResult,
  RouterStatus,
  RouterToolCallRecord,
  RouterView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { toRouterMessageRecord } from "../persistence/mappers";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { DatabaseService } from "../persistence/database.service";
import { ModelBrokerService } from "../models/model-broker.service";
import { ModelProviderService } from "../models/model-provider.service";
import { ModelTokenService } from "../models/model-token.service";
import { RouterToolBrokerService } from "./router-tool-broker.service";
import { RouterToolService } from "./router-tool.service";
import { routerExtensionSource } from "./router-extension";

export const ROUTER_RUNTIME_OPTIONS = Symbol("AGENT_IN_BOX_ROUTER_RUNTIME_OPTIONS");

export interface RouterConnectionFactoryInput {
  sessionRoot: string;
  extensionPath: string;
  piBinary: string;
  piArgsPrefix: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface RouterRuntimeOptions {
  dataRoot?: string;
  piBinary?: string;
  piArgsPrefix?: readonly string[];
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  toolTokenTtlMs?: number;
  turnTimeoutMs?: number;
  now?: () => Date;
  connectionFactory?: (input: RouterConnectionFactoryInput) => WorkerEngine;
}

interface ActiveRouter {
  engine: WorkerEngine;
  sessionId: string;
  modelTokenId: string;
  toolToken: string;
  toolTokenExpiresAt: number;
  textBuffer: string;
  aborting: boolean;
  lastTool: string | null;
  turnTimer: NodeJS.Timeout | null;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are the Agent-in-Box Router running locally on the host.",
  "You never operate a VM desktop, never run host shell commands, and never call the VM Supervisor.",
  "Only the provided project, task, Worker, board and archive tools are available.",
  "Before creating a task for an existing project, call list_active_workers and find_related_worker to decide whether to reuse, resume or create a Worker.",
  "If the user's request is ambiguous or lacks a target project, ask a concise clarification question instead of guessing.",
  "The task board is authoritative. Never claim a task is complete; report the persisted task status and evidence instead.",
  "Create tasks with explicit, verifiable objectives. Keep replies concise and do not pretend a VM action happened.",
].join("\n");

@Injectable()
export class RouterRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RouterRuntimeService.name);
  private readonly dataRoot: string;
  private readonly piBinary: string;
  private readonly piArgsPrefix: readonly string[];
  private readonly extensionPathOverride?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly toolTokenTtlMs: number;
  private readonly turnTimeoutMs: number;
  private readonly now: () => Date;
  private readonly connectionFactory: (input: RouterConnectionFactoryInput) => WorkerEngine;
  private active: ActiveRouter | null = null;
  private conversationId: string | null = null;
  private conversationPromise: Promise<string> | null = null;
  private sessionPromise: Promise<ActiveRouter> | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private turnInFlight = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly database: DatabaseService,
    private readonly providers: ModelProviderService,
    private readonly tokens: ModelTokenService,
    private readonly broker: ModelBrokerService,
    private readonly toolBroker: RouterToolBrokerService,
    private readonly tools: RouterToolService,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(ROUTER_RUNTIME_OPTIONS) options: RouterRuntimeOptions = {},
  ) {
    this.dataRoot = options.dataRoot ?? database.layout.root;
    this.piBinary = options.piBinary ?? process.env.AGENT_IN_BOX_ROUTER_PI_BINARY?.trim() ?? "pi";
    this.piArgsPrefix = options.piArgsPrefix ?? readArgsPrefix();
    if (options.extensionPath) this.extensionPathOverride = options.extensionPath;
    this.env = options.env ?? process.env;
    this.toolTokenTtlMs = Math.max(60_000, options.toolTokenTtlMs ?? 8 * 60 * 60_000);
    this.turnTimeoutMs = Math.max(1_000, options.turnTimeoutMs ?? 10 * 60_000);
    this.now = options.now ?? (() => new Date());
    this.connectionFactory =
      options.connectionFactory ??
      ((input) =>
        new PiWorkerEngine({
          sessionRoot: input.sessionRoot,
          piBinary: input.piBinary,
          extensionPath: input.extensionPath,
          env: input.env,
          argsPrefix: input.piArgsPrefix,
          engineVersion: PI_ENGINE_VERSION,
          sessionVersion: PI_SESSION_FORMAT_VERSION,
        }));
  }

  async onModuleInit(): Promise<void> {
    await this.db
      .updateTable("router_sessions")
      .set({
        status: "failed",
        last_error: "control_plane_restarted",
        tool_token_hash: null,
        tool_token_expires_at: null,
        updated_at: nowIso(),
      })
      .where("status", "in", ["starting", "running"])
      .execute();
    // An idle session row may outlive its process. Clear every tool token so a
    // Router Pi that survived a crash cannot keep calling tools after restart.
    await this.db
      .updateTable("router_sessions")
      .set({
        tool_token_hash: null,
        tool_token_expires_at: null,
        updated_at: nowIso(),
      })
      .where("status", "=", "idle")
      .execute();
    this.renewTimer = setInterval(() => void this.renewTokens(), 5 * 60_000);
    this.renewTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.turnInFlight = false;
    if (this.renewTimer) clearInterval(this.renewTimer);
    const active = this.active;
    this.active = null;
    if (!active) return;
    if (active.turnTimer) clearTimeout(active.turnTimer);
    await active.engine.dispose?.().catch(() => undefined);
    await this.tokens.revokeRouter(active.modelTokenId, "router_stopped").catch(() => undefined);
    await this.db
      .updateTable("router_sessions")
      .set({
        status: "failed",
        last_error: "control_plane_stopped",
        tool_token_hash: null,
        tool_token_expires_at: null,
        updated_at: nowIso(),
      })
      .where("conversation_id", "=", this.conversationId ?? "")
      .execute()
      .catch(() => undefined);
  }

  async view(): Promise<RouterView> {
    const conversationId = await this.ensureConversation();
    const row = await this.requireSessionRow(conversationId);
    const messageCount = await this.db
      .selectFrom("router_messages")
      .select((builder) => builder.fn.countAll<number>().as("count"))
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return {
      conversationId,
      status: this.turnInFlight ? "running" : normalizeStatus(row.status),
      providerId: row.provider_id,
      modelId: row.model_id,
      engineVersion: row.engine_version,
      sessionVersion: row.session_version,
      lastError: row.last_error,
      lastActiveAt: row.last_active_at,
      tools: this.tools.definitions(),
      messageCount: Number(messageCount?.count ?? 0),
    };
  }

  async messages(limit = 100): Promise<RouterMessageRecord[]> {
    const conversationId = await this.ensureConversation();
    const rows = await this.db
      .selectFrom("router_messages")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(200, limit)))
      .execute();
    return rows.reverse().map(toRouterMessageRecord);
  }

  async toolCalls(limit = 50): Promise<RouterToolCallRecord[]> {
    const conversationId = await this.ensureConversation();
    const rows = await this.db
      .selectFrom("router_tool_calls")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(200, limit)))
      .execute();
    return rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      toolName: row.tool_name,
      args: parseJson(row.args_json),
      status: row.status === "ok" ? "ok" : "error",
      errorCode: row.error_code,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  }

  async send(textInput: unknown): Promise<RouterSendResult> {
    const text = typeof textInput === "string" ? textInput.trim() : "";
    if (!text || text.length > 20_000) {
      throw new PersistenceError("validation_failed", "Router 消息必须为 1～20000 个字符");
    }
    const conversationId = await this.ensureConversation();
    const current = await this.requireSessionRow(conversationId);
    if (this.turnInFlight || current.status === "running") {
      throw new PersistenceError("conflict", "Router 仍在处理上一条消息，请稍候或中止");
    }
    this.turnInFlight = true;
    try {
      const userMessage = await this.appendMessage(conversationId, "user", text);
      await this.db
        .updateTable("router_sessions")
        .set({
          status: "running",
          last_error: null,
          last_active_at: nowIso(),
          updated_at: nowIso(),
        })
        .where("conversation_id", "=", conversationId)
        .execute();
      await this.outbox.append(
        "router.status_changed",
        { conversationId, status: "running", error: null },
        nowIso(),
      );
      const active = await this.ensureSession(conversationId);
      active.textBuffer = "";
      active.aborting = false;
      await this.db
        .updateTable("router_sessions")
        .set({ status: "running", last_error: null, updated_at: nowIso() })
        .where("conversation_id", "=", conversationId)
        .execute();
      if (active.turnTimer) clearTimeout(active.turnTimer);
      active.turnTimer = setTimeout(
        () => void this.timeoutTurn(conversationId, active),
        this.turnTimeoutMs,
      );
      active.turnTimer.unref();
      await active.engine.prompt(active.sessionId, { text });
      return {
        conversationId,
        status: "running",
        message: userMessage,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.markFailed(conversationId, message);
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("unavailable", `Router 回合启动失败：${message}`);
    }
  }

  async abort(): Promise<RouterView> {
    const conversationId = await this.ensureConversation();
    const active = this.active;
    if (!active) {
      throw new PersistenceError("conflict", "Router 会话未连接");
    }
    active.aborting = true;
    try {
      await active.engine.abort(active.sessionId);
    } catch (error) {
      this.logger.warn(`Router abort RPC failed: ${errorMessage(error)}`);
    }
    await this.finishTurn(conversationId, active, null);
    return this.view();
  }

  private async ensureSession(conversationId: string): Promise<ActiveRouter> {
    if (this.active) return this.active;
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.startSession(conversationId).finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async startSession(conversationId: string): Promise<ActiveRouter> {
    if (this.stopped) throw new PersistenceError("unavailable", "Router 已停止");
    const model = await this.providers.resolve(
      this.env.AGENT_IN_BOX_ROUTER_PROVIDER?.trim() || undefined,
      this.env.AGENT_IN_BOX_ROUTER_MODEL?.trim() || undefined,
    );
    const toolToken = randomBytes(32).toString("base64url");
    const toolTokenExpiresAt = this.now().getTime() + this.toolTokenTtlMs;
    const routerDir = path.join(this.dataRoot, "router");
    const sessionRoot = path.join(routerDir, "pi");
    const workspacePath = path.join(routerDir, "workspace");
    const extensionPath = this.extensionPathOverride ?? path.join(routerDir, "router-extension.js");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    if (!this.extensionPathOverride) {
      await writeFile(extensionPath, routerExtensionSource(this.tools.definitions()), {
        mode: 0o600,
      });
    }
    await this.db
      .updateTable("router_sessions")
      .set({
        status: "starting",
        tool_token_hash: hash(toolToken),
        tool_token_expires_at: new Date(toolTokenExpiresAt).toISOString(),
        provider_id: model.provider.id,
        model_id: model.model.id,
        last_error: null,
        updated_at: nowIso(),
      })
      .where("conversation_id", "=", conversationId)
      .execute();
    const token = await this.tokens.issueRouter({
      conversationId,
      providerId: model.provider.id,
      model: model.model.id,
    });
    const recovered = await this.priorConversationSummary(conversationId);
    const spec = this.sessionSpec(
      conversationId,
      workspacePath,
      model.provider.id,
      model.model.id,
      token.token,
      model.provider.api,
      model.model.reasoning === true,
      recovered
        ? `${DEFAULT_SYSTEM_PROMPT}\n\n## Recovered Router conversation\n${recovered}`
        : undefined,
    );
    const engine = this.connectionFactory({
      sessionRoot,
      extensionPath,
      piBinary: this.piBinary,
      piArgsPrefix: this.piArgsPrefix,
      env: {
        ...this.env,
        AGENT_IN_BOX_ROUTER_URL: `http://127.0.0.1:${this.toolBroker.port}`,
        AGENT_IN_BOX_ROUTER_TOKEN: toolToken,
      },
    });
    const existing = await this.requireSessionRow(conversationId);
    let handle: WorkerSessionHandle;
    try {
      handle = existing.session_ref
        ? await engine.resume(existing.session_ref, spec)
        : await engine.startSession(spec);
    } catch (error) {
      await engine.dispose?.().catch(() => undefined);
      if (!existing.session_ref) {
        await this.tokens.revokeRouter(token.context.id, "router_start_failed");
        throw error;
      }
      this.logger.warn(
        `Router session resume failed; clearing it so the next message starts a recovered session: ${errorMessage(error)}`,
      );
      await this.tokens.revokeRouter(token.context.id, "router_resume_failed");
      await this.db
        .updateTable("router_sessions")
        .set({
          status: "failed",
          session_ref: null,
          tool_token_hash: null,
          tool_token_expires_at: null,
          last_error: `Router 原生会话恢复失败：${errorMessage(error)}`,
          updated_at: nowIso(),
        })
        .where("conversation_id", "=", conversationId)
        .execute();
      throw new PersistenceError(
        "unavailable",
        `Router 原生会话恢复失败；下一次消息将使用最近对话摘要启动新会话：${errorMessage(error)}`,
      );
    }
    const subscribed = this.subscribe(conversationId, engine, handle);
    const active: ActiveRouter = {
      engine,
      sessionId: subscribed.sessionId,
      modelTokenId: token.context.id,
      toolToken,
      toolTokenExpiresAt,
      textBuffer: "",
      aborting: false,
      lastTool: null,
      turnTimer: null,
    };
    this.active = active;
    await this.db
      .updateTable("router_sessions")
      .set({
        status: "idle",
        session_ref: subscribed.archiveRef ?? existing.session_ref,
        engine_type: "pi-rpc",
        engine_version: handle.engineVersion ?? PI_ENGINE_VERSION,
        session_version: handle.sessionVersion ?? PI_SESSION_FORMAT_VERSION,
        last_active_at: nowIso(),
        updated_at: nowIso(),
      })
      .where("conversation_id", "=", conversationId)
      .execute();
    if (this.active !== active) {
      throw new PersistenceError("unavailable", "Router 进程启动后立即退出，请检查日志");
    }
    return active;
  }

  private subscribe(
    conversationId: string,
    engine: WorkerEngine,
    handle: WorkerSessionHandle,
  ): WorkerSessionHandle {
    engine.subscribe(handle.sessionId, (event) => {
      void this.handleEvent(conversationId, event).catch((error: unknown) => {
        this.logger.error(`Router event handling failed: ${errorMessage(error)}`);
      });
    });
    return handle;
  }

  private async handleEvent(conversationId: string, event: WorkerEngineEvent): Promise<void> {
    const active = this.active;
    if (!active) return;
    switch (event.type) {
      case "text_delta":
        active.textBuffer = `${active.textBuffer}${event.delta}`.slice(-200_000);
        return;
      case "tool_started":
        active.lastTool = event.toolName;
        return;
      case "tool_finished":
        active.lastTool = null;
        return;
      case "turn_finished":
        // An explicit Abort/timeout handler owns the resulting state.
        if (active.aborting) return;
        await this.finishTurn(conversationId, active, null);
        return;
      case "session_failed":
        await this.persistPartialText(conversationId, active);
        await this.markFailed(conversationId, event.message);
        return;
      case "session_ended":
        await this.persistPartialText(conversationId, active);
        await this.markFailed(
          conversationId,
          event.reason === "cancelled"
            ? "Router 进程已停止"
            : `Router 进程异常退出（${event.reason}）`,
        );
        return;
      default:
        return;
    }
  }

  private async timeoutTurn(conversationId: string, active: ActiveRouter): Promise<void> {
    if (this.active !== active || !this.turnInFlight) return;
    this.logger.warn(`Router turn exceeded ${this.turnTimeoutMs} ms; aborting it`);
    active.aborting = true;
    try {
      await active.engine.abort(active.sessionId);
    } catch (error) {
      this.logger.warn(`Router timeout abort failed: ${errorMessage(error)}`);
    }
    if (this.active !== active) return;
    await this.persistPartialText(conversationId, active);
    await this.markFailed(conversationId, "Router 回合超过最大时长，已中止");
  }

  private async persistPartialText(conversationId: string, active: ActiveRouter): Promise<void> {
    const text = active.textBuffer.trim();
    active.textBuffer = "";
    if (text) await this.appendMessage(conversationId, "assistant", text.slice(0, 100_000));
  }

  private async finishTurn(
    conversationId: string,
    active: ActiveRouter,
    errorCode: string | null,
  ): Promise<void> {
    if (this.active !== active) return;
    active.aborting = false;
    this.turnInFlight = false;
    if (active.turnTimer) {
      clearTimeout(active.turnTimer);
      active.turnTimer = null;
    }
    const text = active.textBuffer.trim();
    active.textBuffer = "";
    if (text) {
      await this.appendMessage(conversationId, "assistant", text.slice(0, 100_000));
    }
    const status: RouterStatus = errorCode ? "failed" : "idle";
    const error = errorCode ? (active.aborting ? "Router 回合已被用户中止" : errorCode) : null;
    await this.db
      .updateTable("router_sessions")
      .set({
        status,
        last_error: error,
        last_active_at: nowIso(),
        updated_at: nowIso(),
      })
      .where("conversation_id", "=", conversationId)
      .execute();
    await this.outbox.append("router.status_changed", { conversationId, status, error }, nowIso());
  }

  private async markFailed(conversationId: string, message: string): Promise<void> {
    this.turnInFlight = false;
    const active = this.active;
    this.active = null;
    if (active) {
      if (active.turnTimer) clearTimeout(active.turnTimer);
      try {
        await active.engine.dispose?.();
      } catch {
        // The process is already suspect; keep the persisted failure.
      }
      await this.tokens.revokeRouter(active.modelTokenId, "router_failed");
    }
    await this.db
      .updateTable("router_sessions")
      .set({
        status: "failed",
        last_error: message.slice(0, 2000),
        tool_token_hash: null,
        tool_token_expires_at: null,
        last_active_at: nowIso(),
        updated_at: nowIso(),
      })
      .where("conversation_id", "=", conversationId)
      .execute();
    await this.outbox.append(
      "router.status_changed",
      { conversationId, status: "failed", error: message.slice(0, 2000) },
      nowIso(),
    );
  }

  private async renewTokens(): Promise<void> {
    const active = this.active;
    if (!active || !this.conversationId) return;
    try {
      await this.tokens.renewRouter(active.modelTokenId);
      const expiresAt = this.now().getTime() + this.toolTokenTtlMs;
      active.toolTokenExpiresAt = expiresAt;
      await this.db
        .updateTable("router_sessions")
        .set({
          tool_token_hash: hash(active.toolToken),
          tool_token_expires_at: new Date(expiresAt).toISOString(),
          updated_at: nowIso(),
        })
        .where("conversation_id", "=", this.conversationId)
        .execute();
    } catch (error) {
      this.logger.warn(`Router token renewal failed: ${errorMessage(error)}`);
    }
  }

  /**
   * A fresh Router session cannot restore hidden model context. Re-inject a
   * bounded transcript summary so the user can continue without pretending it
   * was a lossless native resume.
   */
  private async priorConversationSummary(conversationId: string): Promise<string> {
    const rows = await this.db
      .selectFrom("router_messages")
      .select(["role", "content"])
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(12)
      .execute();
    if (rows.length === 0) return "";
    return rows
      .reverse()
      .map((row) => `${row.role === "assistant" ? "Router" : "User"}: ${row.content.slice(0, 500)}`)
      .join("\n")
      .slice(0, 4000);
  }

  private sessionSpec(
    conversationId: string,
    workspacePath: string,
    providerId: string,
    modelId: string,
    routerToken: string,
    api: "openai-completions" | "anthropic-messages",
    reasoning: boolean,
    systemPrompt?: string,
  ): WorkerSessionSpec {
    return {
      workerId: `router-${conversationId}`,
      projectId: "router",
      vmId: "host",
      workspacePath,
      engineType: "pi-rpc",
      engineVersion: PI_ENGINE_VERSION,
      sessionVersion: PI_SESSION_FORMAT_VERSION,
      systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      capabilities: [],
      provider: providerId,
      model: modelId,
      modelBroker: {
        baseUrl: `http://127.0.0.1:${this.broker.port}`,
        token: routerToken,
        provider: providerId,
        model: modelId,
        api,
        reasoning,
      },
    };
  }

  private async ensureConversation(): Promise<string> {
    if (this.conversationId) return this.conversationId;
    if (this.conversationPromise) return this.conversationPromise;
    this.conversationPromise = this.loadOrCreateConversation().finally(() => {
      this.conversationPromise = null;
    });
    return this.conversationPromise;
  }

  private async loadOrCreateConversation(): Promise<string> {
    const existing = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("kind", "=", "router")
      .orderBy("last_message_at", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (existing) {
      this.conversationId = existing.id;
      return existing.id;
    }
    const now = nowIso();
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("conversations")
        .values({
          id,
          kind: "router",
          project_id: null,
          title: "Router 主会话",
          created_at: now,
          last_message_at: now,
        })
        .execute();
      await trx
        .insertInto("router_sessions")
        .values({
          conversation_id: id,
          status: "idle",
          session_ref: null,
          engine_type: "pi-rpc",
          engine_version: PI_ENGINE_VERSION,
          session_version: PI_SESSION_FORMAT_VERSION,
          provider_id: null,
          model_id: null,
          tool_token_hash: null,
          tool_token_expires_at: null,
          last_active_at: now,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    });
    this.conversationId = id;
    return id;
  }

  private async requireSessionRow(conversationId: string): Promise<{
    conversation_id: string;
    status: string;
    session_ref: string | null;
    provider_id: string | null;
    model_id: string | null;
    engine_version: string;
    session_version: string;
    last_error: string | null;
    last_active_at: string;
  }> {
    const row = await this.db
      .selectFrom("router_sessions")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (row) return row;
    const now = nowIso();
    await this.db
      .insertInto("router_sessions")
      .values({
        conversation_id: conversationId,
        status: "idle",
        session_ref: null,
        engine_type: "pi-rpc",
        engine_version: PI_ENGINE_VERSION,
        session_version: PI_SESSION_FORMAT_VERSION,
        provider_id: null,
        model_id: null,
        tool_token_hash: null,
        tool_token_expires_at: null,
        last_active_at: now,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.column("conversation_id").doNothing())
      .execute();
    return this.db
      .selectFrom("router_sessions")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();
  }

  private async appendMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<RouterMessageRecord> {
    const now = nowIso();
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("router_messages")
        .values({
          id,
          conversation_id: conversationId,
          role,
          content: content.slice(0, 100_000),
          created_at: now,
        })
        .execute();
      await trx
        .updateTable("conversations")
        .set({ last_message_at: now })
        .where("id", "=", conversationId)
        .execute();
    });
    await this.outbox.append("router.message", { conversationId, messageId: id, role }, now);
    return { id, conversationId, role, content: content.slice(0, 100_000), createdAt: now };
  }
}

function normalizeStatus(value: string): RouterStatus {
  return value === "running" || value === "failed" ? value : "idle";
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readArgsPrefix(): readonly string[] {
  const raw = process.env.AGENT_IN_BOX_ROUTER_PI_ARGS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("expected a JSON string array");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `AGENT_IN_BOX_ROUTER_PI_ARGS must be a JSON string array: ${errorMessage(error)}`,
    );
  }
}
