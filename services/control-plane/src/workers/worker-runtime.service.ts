import { randomUUID } from "node:crypto";
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
  WorkerRpcClient,
  type WorkerEngineEvent,
  type WorkerInput,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type {
  ConversationMessageRecord,
  WorkerCreateRequest,
  WorkerPromptRequest,
  WorkerRecord,
  WorkerRuntimeView,
  WorkerSteerResult,
  WorkerView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { ModelBrokerService } from "../models/model-broker.service";
import { ModelProviderService } from "../models/model-provider.service";
import { ModelTokenService } from "../models/model-token.service";
import { CuaBrokerService } from "../computer-use/cua-broker.service";
import { CuaExecutionService } from "../computer-use/cua-execution.service";
import { CuaTokenService } from "../computer-use/cua-token.service";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { TaskService } from "../persistence/services/task-service";
import { SupervisorClient } from "../vms/supervisor.client";

export const WORKER_RUNTIME_OPTIONS = Symbol("AGENT_IN_BOX_WORKER_RUNTIME_OPTIONS");

export interface WorkerGuestTarget {
  workerId: string;
  vmId: string;
  hostPort: number;
  storageRoot: string;
}

export interface WorkerGuestConnection {
  handshake(): Promise<{
    protocolVersion: string;
    engineType: string;
    engineVersion: string;
    sessionVersion: string;
    compatible: boolean;
  }>;
  startSession(spec: WorkerSessionSpec): Promise<WorkerSessionHandle>;
  resume(
    archiveRef: string,
    spec: WorkerSessionSpec,
  ): Promise<WorkerSessionHandle & { mode: string }>;
  prompt(sessionId: string, input: WorkerInput): Promise<void>;
  steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  abort(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<{ archiveRef: string; summary: string }>;
  session(sessionId: string): Promise<unknown>;
  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void;
}

export interface WorkerRuntimeOptions {
  connectorFactory?: (target: WorkerGuestTarget) => WorkerGuestConnection;
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFailureThreshold?: number;
  brokerBaseUrl?: string;
  cuaBrokerBaseUrl?: string;
  systemPrompt?: string;
  now?: () => Date;
}

interface ActiveWorker {
  connection: WorkerGuestConnection;
  sessionId: string;
  engineVersion: string;
  sessionVersion: string;
  unsubscribe: () => void;
  tokenId: string;
  cuaTokenId: string;
  leaseId: string | null;
  taskId: string | null;
  textBuffer: string;
  aborting: boolean;
  heartbeatFailures: number;
  lastHeartbeatAt: number;
  lastRenewAt: number;
  lastLeaseRenewAt: number;
  completedTaskAt: number | null;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are an Agent-in-Box Worker running inside the Linux VM.",
  "Operate the guest desktop with the vm_* Computer Use tools when the task requires it.",
  "The current task is provided by the host. Use the guest workspace for files.",
  "Never request or expose host credentials, the VM Supervisor, the Model Broker key, or host filesystem paths.",
  "If the task cannot be completed safely, explain the blocker in your final message.",
].join("\n");

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly active = new Map<string, ActiveWorker>();
  private readonly tickIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatFailureThreshold: number;
  private readonly connectorFactory: (target: WorkerGuestTarget) => WorkerGuestConnection;
  private readonly now: () => Date;
  private readonly systemPrompt: string;
  private readonly brokerBaseUrlOverride?: string;
  private readonly cuaBrokerBaseUrlOverride?: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly workers: WorkerRepository,
    private readonly outbox: OutboxRepository,
    private readonly tasks: TaskService,
    private readonly leases: LeaseService,
    private readonly leaseRepository: LeaseRepository,
    private readonly supervisor: SupervisorClient,
    private readonly providers: ModelProviderService,
    private readonly tokens: ModelTokenService,
    private readonly broker: ModelBrokerService,
    private readonly cuaTokens: CuaTokenService,
    private readonly cua: CuaExecutionService,
    private readonly cuaBrokerService: CuaBrokerService,
    @Optional() @Inject(WORKER_RUNTIME_OPTIONS) options: WorkerRuntimeOptions = {},
  ) {
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? 750);
    this.heartbeatIntervalMs = Math.max(1000, options.heartbeatIntervalMs ?? 10_000);
    this.heartbeatFailureThreshold = Math.max(1, options.heartbeatFailureThreshold ?? 3);
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.now = options.now ?? (() => new Date());
    if (options.brokerBaseUrl) this.brokerBaseUrlOverride = options.brokerBaseUrl;
    if (options.cuaBrokerBaseUrl) this.cuaBrokerBaseUrlOverride = options.cuaBrokerBaseUrl;
    if (options.connectorFactory) {
      this.connectorFactory = options.connectorFactory;
    } else {
      this.connectorFactory = (target) =>
        new WorkerRpcClient({
          baseUrl: `http://127.0.0.1:${target.hostPort}`,
          tokenFile:
            process.env.AGENT_IN_BOX_WORKER_TOKEN_FILE?.trim() ||
            `${target.storageRoot}/worker-rpc.token`,
        });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.reconcileRestart();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const worker of this.active.values()) worker.unsubscribe();
    this.active.clear();
    // Do not kill Guest Pi processes on control-plane exit. The next start
    // reconciles their persisted bindings instead of pretending they still run.
  }

  async create(input: WorkerCreateRequest): Promise<WorkerView> {
    const project = await this.db
      .selectFrom("projects")
      .select(["id", "archived_at"])
      .where("id", "=", input?.projectId)
      .executeTakeFirst();
    if (!project) throw new PersistenceError("not_found", `项目不存在：${input?.projectId}`);
    if (project.archived_at) throw new PersistenceError("conflict", "已归档项目不能创建 Worker");
    const binding = await this.db
      .selectFrom("project_vm_bindings")
      .select(["guest_workspace_path"])
      .where("project_id", "=", input.projectId)
      .where("vm_id", "=", input.vmId)
      .executeTakeFirst();
    if (!binding) throw new PersistenceError("validation_failed", "目标 VM 尚未绑定到该项目");
    const vm = await this.requireVm(input.vmId);
    if (vm.powerState !== "running") {
      throw new PersistenceError("conflict", "只有运行中的 VM 可以启动 Worker");
    }
    const conversationId = await this.resolveConversation(input);
    const existing = await this.workers.findReusable(input.projectId, input.vmId, conversationId);
    if (existing) {
      if (!this.active.has(existing.id)) {
        throw new PersistenceError(
          "conflict",
          `Worker ${existing.id} 已存在（${existing.status}）；请恢复或归档后重试`,
        );
      }
      return this.view(existing);
    }
    const model = await this.providers.resolve(input.providerId, input.model);
    const runtime = await this.supervisor.get(input.vmId);
    if (!runtime.workerHostPort) {
      throw new PersistenceError("unavailable", "该 VM 没有分配 Guest Worker RPC 回环端口");
    }
    const target: WorkerGuestTarget = {
      workerId: "",
      vmId: input.vmId,
      hostPort: runtime.workerHostPort,
      storageRoot: vm.storageRoot,
    };
    const connection = this.connectorFactory(target);
    const handshake = await connection.handshake().catch((error: unknown) => {
      throw new PersistenceError(
        "unavailable",
        `无法连接 Guest Worker RPC：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!handshake.compatible) {
      throw new PersistenceError(
        "conflict",
        `Worker RPC/Engine 版本不兼容（protocol=${handshake.protocolVersion}, engine=${handshake.engineVersion}, session=${handshake.sessionVersion}）`,
      );
    }
    if (
      handshake.engineVersion !== PI_ENGINE_VERSION ||
      handshake.sessionVersion !== PI_SESSION_FORMAT_VERSION
    ) {
      throw new PersistenceError(
        "conflict",
        `Worker 版本不兼容：要求 Pi ${PI_ENGINE_VERSION} / Session ${PI_SESSION_FORMAT_VERSION}，Guest 为 ${handshake.engineVersion} / ${handshake.sessionVersion}`,
      );
    }
    const worker = await this.workers.createWorker({
      projectId: input.projectId,
      vmId: input.vmId,
      conversationId,
      engineType: "pi-rpc",
      engineVersion: handshake.engineVersion,
      capabilitySet: ["computer_use"],
    });
    const token = await this.tokens.issue({
      workerId: worker.id,
      vmId: worker.vmId,
      sessionId: "pending",
      providerId: model.provider.id,
      model: model.model.id,
      taskId: null,
    });
    const cuaToken = await this.cuaTokens.issue({
      workerId: worker.id,
      vmId: worker.vmId,
      sessionId: "pending",
      taskId: null,
    });
    try {
      const handle = await connection.startSession({
        workerId: worker.id,
        projectId: worker.projectId,
        vmId: worker.vmId,
        workspacePath: binding.guest_workspace_path,
        engineType: "pi-rpc",
        engineVersion: PI_ENGINE_VERSION,
        sessionVersion: PI_SESSION_FORMAT_VERSION,
        systemPrompt: this.systemPrompt,
        capabilities: ["computer_use"],
        provider: model.provider.id,
        model: model.model.id,
        modelBroker: {
          baseUrl: this.brokerBaseUrl(),
          token: token.token,
          provider: model.provider.id,
          model: model.model.id,
          api: model.provider.api,
          reasoning: model.model.reasoning === true,
        },
        computerUse: {
          baseUrl: this.cuaBrokerBaseUrl(),
          token: cuaToken.token,
        },
      });
      await Promise.all([
        this.tokens.bindSession(token.context.id, handle.sessionId),
        this.cuaTokens.bindSession(cuaToken.context.id, handle.sessionId),
      ]);
      const updated = await this.workers.updateRuntime(worker.id, {
        status: "idle",
        agentSessionRef: handle.archiveRef ?? null,
        sessionVersion: handle.sessionVersion ?? handshake.sessionVersion,
        lastHeartbeatAt: nowIso(),
        lastErrorCode: null,
        lastErrorMessage: null,
        brokerTokenId: token.context.id,
        providerId: model.provider.id,
        modelId: model.model.id,
      });
      this.attach(worker.id, connection, handle, token.context.id, cuaToken.context.id);
      this.scheduleTick();
      return this.view(updated ?? worker);
    } catch (error) {
      await Promise.all([
        this.tokens.revoke(token.context.id, "worker_start_failed"),
        this.cuaTokens.revoke(cuaToken.context.id, "worker_start_failed"),
      ]);
      await this.workers.updateRuntime(worker.id, {
        status: "failed",
        lastErrorCode: "worker_start_failed",
        lastErrorMessage: errorMessage(error),
      });
      throw new PersistenceError("unavailable", `Worker 会话启动失败：${errorMessage(error)}`);
    }
  }

  async list(projectId?: string): Promise<WorkerView[]> {
    const workers = projectId
      ? await this.workers.listByProject(projectId, 100)
      : await this.workers.listActive(undefined, 100);
    return workers.map((worker) => this.view(worker));
  }

  async get(workerId: string): Promise<WorkerView> {
    return this.view(await this.requireWorker(workerId));
  }

  async prompt(
    workerId: string,
    input: WorkerPromptRequest,
  ): Promise<{ taskId: string; worker: WorkerView }> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (!active || worker.status !== "idle") {
      throw new PersistenceError(
        "conflict",
        worker.status === "archived"
          ? "Worker 已归档，请先恢复会话"
          : worker.status === "failed"
            ? "Worker 已失败，请先恢复会话"
            : "Worker 正在执行任务，请使用 steer 或 follow-up",
      );
    }
    const text = validatePromptText(input?.text);
    const task = await this.tasks.create({
      projectId: worker.projectId,
      vmId: worker.vmId,
      originConversationId: worker.conversationId,
      objective: text,
      idempotencyKey: `worker:${workerId}:${randomUUID()}`,
    });
    await this.appendMessage(worker, task.task.id, "user", "prompt", text);
    await this.workers.touch(workerId);
    await this.tick();
    return { taskId: task.task.id, worker: await this.get(workerId) };
  }

  async steer(workerId: string, input: WorkerPromptRequest): Promise<WorkerSteerResult> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (!active || !active.taskId)
      throw new PersistenceError("conflict", "Worker 当前没有运行中的任务");
    const task = await this.tasks.get(active.taskId);
    if (!task || task.status !== "running") {
      throw new PersistenceError("conflict", "Worker 当前任务不处于运行状态");
    }
    const text = validatePromptText(input?.text);
    const disposition = await active.connection.steer(active.sessionId, { text });
    await this.appendMessage(worker, active.taskId, "user", "steer", text);
    await this.tasks.recordWorkerEvent(active.taskId, "worker.steer", { disposition });
    return { disposition, taskId: active.taskId };
  }

  async followUp(workerId: string, input: WorkerPromptRequest): Promise<WorkerSteerResult> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (!active) throw new PersistenceError("conflict", "Worker 会话未连接");
    const text = validatePromptText(input?.text);
    const disposition = await active.connection.followUp(active.sessionId, { text });
    await this.appendMessage(worker, active.taskId, "user", "follow_up", text);
    if (active.taskId) {
      await this.tasks.recordWorkerEvent(active.taskId, "worker.follow_up", { disposition });
    }
    return { disposition, taskId: active.taskId };
  }

  async abort(workerId: string, reason = "用户中止 Worker 回合"): Promise<WorkerView> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (!active) throw new PersistenceError("conflict", "Worker 会话未连接");
    await this.abortTurn(worker, active, "worker_aborted", reason, false);
    return this.get(workerId);
  }

  async archive(workerId: string): Promise<WorkerView> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (active?.taskId) throw new PersistenceError("conflict", "Worker 仍有运行任务，不能归档");
    if (!active) throw new PersistenceError("conflict", "Worker 会话未连接，无法安全归档");
    const archived = await active.connection.archive(active.sessionId);
    active.unsubscribe();
    this.active.delete(workerId);
    await Promise.all([
      this.tokens.revoke(active.tokenId, "worker_archived"),
      this.cuaTokens.revoke(active.cuaTokenId, "worker_archived"),
    ]);
    if (active.leaseId) await this.leases.release(worker.vmId, active.leaseId);
    const updated = await this.workers.updateRuntime(workerId, {
      status: "archived",
      currentTaskId: null,
      agentSessionRef: archived.archiveRef,
      archiveSummary: archived.summary,
      lastHeartbeatAt: null,
      brokerTokenId: null,
    });
    await this.db
      .updateTable("workers")
      .set({ archived_at: nowIso() })
      .where("id", "=", workerId)
      .execute();
    await this.outbox.append(
      "worker.archived",
      { workerId, summaryRef: archived.archiveRef },
      nowIso(),
    );
    return this.view(updated ?? worker);
  }

  async resume(workerId: string): Promise<WorkerView> {
    const worker = await this.requireWorker(workerId);
    if (this.active.has(workerId)) throw new PersistenceError("conflict", "Worker 已经连接");
    if (!worker.agentSessionRef) {
      throw new PersistenceError("conflict", "Worker 没有可恢复的会话归档");
    }
    if (worker.status !== "archived" && worker.status !== "failed") {
      throw new PersistenceError("conflict", `Worker 状态 ${worker.status} 不能恢复`);
    }
    const [binding, vm, model] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .select(["guest_workspace_path"])
        .where("project_id", "=", worker.projectId)
        .where("vm_id", "=", worker.vmId)
        .executeTakeFirst(),
      this.requireVm(worker.vmId),
      this.providers.resolve(worker.providerId ?? undefined, worker.modelId ?? undefined),
    ]);
    if (!binding) throw new PersistenceError("conflict", "目标 VM 已解绑，不能恢复 Worker");
    if (vm.powerState !== "running") throw new PersistenceError("conflict", "目标 VM 未运行");
    const runtime = await this.supervisor.get(worker.vmId);
    if (!runtime.workerHostPort)
      throw new PersistenceError("unavailable", "VM 没有 Worker RPC 端口");
    const connection = this.connectorFactory({
      workerId,
      vmId: worker.vmId,
      hostPort: runtime.workerHostPort,
      storageRoot: vm.storageRoot,
    });
    const token = await this.tokens.issue({
      workerId,
      vmId: worker.vmId,
      sessionId: "pending",
      providerId: model.provider.id,
      model: model.model.id,
      taskId: null,
    });
    const cuaToken = await this.cuaTokens.issue({
      workerId,
      vmId: worker.vmId,
      sessionId: "pending",
      taskId: null,
    });
    try {
      const spec = this.sessionSpec(
        worker,
        binding.guest_workspace_path,
        model.provider.id,
        model.model.id,
        token.token,
        cuaToken.token,
        model.provider.api,
        model.model.reasoning === true,
      );
      const handle = await connection.resume(worker.agentSessionRef, spec);
      await Promise.all([
        this.tokens.bindSession(token.context.id, handle.sessionId),
        this.cuaTokens.bindSession(cuaToken.context.id, handle.sessionId),
      ]);
      const updated = await this.workers.updateRuntime(workerId, {
        status: "idle",
        currentTaskId: null,
        agentSessionRef: handle.archiveRef ?? worker.agentSessionRef,
        sessionVersion: handle.sessionVersion ?? worker.sessionVersion,
        lastHeartbeatAt: nowIso(),
        lastErrorCode: null,
        lastErrorMessage: null,
        brokerTokenId: token.context.id,
      });
      await this.db
        .updateTable("workers")
        .set({ archived_at: null })
        .where("id", "=", workerId)
        .execute();
      this.attach(workerId, connection, handle, token.context.id, cuaToken.context.id);
      await this.outbox.append(
        "worker.resumed",
        { workerId, restoreMode: handle.mode === "summary" ? "summary" : "native" },
        nowIso(),
      );
      this.scheduleTick();
      return this.view(updated ?? worker);
    } catch (error) {
      await Promise.all([
        this.tokens.revoke(token.context.id, "worker_resume_failed"),
        this.cuaTokens.revoke(cuaToken.context.id, "worker_resume_failed"),
      ]);
      await this.workers.updateRuntime(workerId, {
        status: "failed",
        lastErrorCode: "worker_resume_failed",
        lastErrorMessage: errorMessage(error),
      });
      throw new PersistenceError("unavailable", `Worker 会话恢复失败：${errorMessage(error)}`);
    }
  }

  async messages(workerId: string, limit = 100): Promise<ConversationMessageRecord[]> {
    const worker = await this.requireWorker(workerId);
    const rows = await this.db
      .selectFrom("conversation_messages")
      .selectAll()
      .where("conversation_id", "=", worker.conversationId)
      .where("worker_id", "=", workerId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(200, limit)))
      .execute();
    return rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      workerId: row.worker_id,
      taskId: row.task_id,
      role: row.role === "user" ? "user" : "assistant",
      mode: row.mode as ConversationMessageRecord["mode"],
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private view(worker: WorkerRecord): WorkerView {
    const active = this.active.get(worker.id);
    const runtime: WorkerRuntimeView = {
      connected: Boolean(active),
      protocolVersion: active ? "0.1.0" : null,
      engineVersion: worker.engineVersion || null,
      sessionVersion: worker.sessionVersion,
      lastError: worker.lastErrorMessage,
    };
    return { worker, runtime };
  }

  private async requireWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.workers.getWorker(workerId);
    if (!worker) throw new PersistenceError("not_found", `Worker 不存在：${workerId}`);
    return worker;
  }

  private async requireVm(vmId: string): Promise<{
    id: string;
    powerState: string;
    storageRoot: string;
  }> {
    const row = await this.db
      .selectFrom("vm_instances")
      .select(["id", "power_state", "storage_root"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", `VM 不存在：${vmId}`);
    return { id: row.id, powerState: row.power_state, storageRoot: row.storage_root };
  }

  private async resolveConversation(input: WorkerCreateRequest): Promise<string> {
    if (input.conversationId) {
      const conversation = await this.db
        .selectFrom("conversations")
        .select(["id", "project_id", "kind"])
        .where("id", "=", input.conversationId)
        .executeTakeFirst();
      if (!conversation || conversation.project_id !== input.projectId) {
        throw new PersistenceError("validation_failed", "会话不属于该项目");
      }
      return conversation.id;
    }
    const existing = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("project_id", "=", input.projectId)
      .where("kind", "=", "project")
      .orderBy("last_message_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (existing) return existing.id;
    const now = nowIso();
    const id = randomUUID();
    await this.db
      .insertInto("conversations")
      .values({
        id,
        kind: "project",
        project_id: input.projectId,
        title: "项目 Worker 会话",
        created_at: now,
        last_message_at: now,
      })
      .execute();
    return id;
  }

  private brokerBaseUrl(): string {
    if (this.brokerBaseUrlOverride) return this.brokerBaseUrlOverride;
    const fromEnv = process.env.AGENT_IN_BOX_MODEL_BROKER_GUEST_URL?.trim();
    if (fromEnv) return fromEnv;
    return `http://10.0.2.2:${this.broker.port}`;
  }

  private cuaBrokerBaseUrl(): string {
    if (this.cuaBrokerBaseUrlOverride) return this.cuaBrokerBaseUrlOverride;
    return this.cuaBrokerService.guestBaseUrl();
  }

  private sessionSpec(
    worker: WorkerRecord,
    workspacePath: string,
    providerId: string,
    modelId: string,
    brokerToken: string,
    cuaToken: string,
    providerApi: "openai-completions" | "anthropic-messages" = "openai-completions",
    reasoning = false,
  ): WorkerSessionSpec {
    return {
      workerId: worker.id,
      projectId: worker.projectId,
      vmId: worker.vmId,
      workspacePath,
      engineType: "pi-rpc",
      engineVersion: PI_ENGINE_VERSION,
      sessionVersion: PI_SESSION_FORMAT_VERSION,
      systemPrompt: this.systemPrompt,
      capabilities: ["computer_use"],
      provider: providerId,
      model: modelId,
      modelBroker: {
        baseUrl: this.brokerBaseUrl(),
        token: brokerToken,
        provider: providerId,
        model: modelId,
        api: providerApi,
        reasoning,
      },
      computerUse: { baseUrl: this.cuaBrokerBaseUrl(), token: cuaToken },
    };
  }

  private attach(
    workerId: string,
    connection: WorkerGuestConnection,
    handle: WorkerSessionHandle,
    tokenId: string,
    cuaTokenId: string,
  ): void {
    const previous = this.active.get(workerId);
    previous?.unsubscribe();
    const active: ActiveWorker = {
      connection,
      sessionId: handle.sessionId,
      engineVersion: handle.engineVersion ?? PI_ENGINE_VERSION,
      sessionVersion: handle.sessionVersion ?? PI_SESSION_FORMAT_VERSION,
      unsubscribe: () => undefined,
      tokenId,
      cuaTokenId,
      leaseId: null,
      taskId: null,
      textBuffer: "",
      aborting: false,
      heartbeatFailures: 0,
      lastHeartbeatAt: Date.now(),
      lastRenewAt: Date.now(),
      lastLeaseRenewAt: Date.now(),
      completedTaskAt: null,
    };
    active.unsubscribe = connection.subscribe(handle.sessionId, (event) => {
      void this.handleEvent(workerId, event).catch((error: unknown) => {
        this.logger.error(`Worker event handling failed: ${errorMessage(error)}`);
      });
    });
    this.active.set(workerId, active);
  }

  private async handleEvent(workerId: string, event: WorkerEngineEvent): Promise<void> {
    const active = this.active.get(workerId);
    if (!active) return;
    await this.workers.touch(workerId);
    active.lastHeartbeatAt = Date.now();
    switch (event.type) {
      case "text_delta":
        active.textBuffer = `${active.textBuffer}${event.delta}`.slice(-100_000);
        return;
      case "tool_started":
        if (active.taskId) {
          await this.tasks.recordWorkerEvent(active.taskId, "worker.tool_started", {
            toolName: event.toolName,
          });
        }
        return;
      case "tool_finished":
        if (active.taskId) {
          await this.tasks.recordWorkerEvent(active.taskId, "worker.tool_finished", {
            toolName: event.toolName,
            isError: event.isError,
          });
        }
        return;
      case "waiting_approval":
        if (active.taskId) {
          await this.tasks.recordWorkerEvent(active.taskId, "worker.waiting_approval", {
            reason: event.reason,
          });
        }
        return;
      case "turn_finished":
        await this.finishTurn(workerId, active);
        return;
      case "session_failed":
        await this.failWorker(workerId, active, "worker_rpc_failed", event.message);
        return;
      case "session_ended":
        await this.finishTurn(
          workerId,
          active,
          event.reason === "failed" ? "worker_rpc_exited" : undefined,
        );
        return;
      default:
        return;
    }
  }

  private async finishTurn(
    workerId: string,
    active: ActiveWorker,
    interruptedCode?: string,
  ): Promise<void> {
    if (active.aborting) {
      active.aborting = false;
      return;
    }
    const worker = await this.workers.getWorker(workerId);
    if (!worker) return;
    const taskId = active.taskId;
    const summary = active.textBuffer.trim().slice(0, 4000);
    active.textBuffer = "";
    if (summary) {
      await this.appendMessage(worker, taskId, "assistant", "event", summary);
    }
    if (active.leaseId) {
      await this.leases.release(worker.vmId, active.leaseId);
      active.leaseId = null;
    }
    if (active.tokenId) await this.tokens.bindTask(active.tokenId, null);
    if (active.cuaTokenId) await this.cuaTokens.bindTask(active.cuaTokenId, null);
    active.taskId = null;
    active.completedTaskAt = null;
    await this.workers.updateRuntime(workerId, {
      status: "idle",
      currentTaskId: null,
      lastHeartbeatAt: nowIso(),
    });
    if (taskId) {
      const task = await this.tasks.get(taskId);
      if (task?.status === "completed") {
        await this.cua.finishExecution(taskId, "completed");
        return;
      }
      if (task && (task.status === "running" || task.status === "waiting_approval")) {
        await this.tasks.recordWorkerEvent(taskId, "worker.turn_finished", {
          summary: summary || null,
        });
        await this.tasks.block(
          taskId,
          interruptedCode ?? "awaiting_verification",
          interruptedCode
            ? "Worker 回合异常结束，需要重新观察 VM 后再重试"
            : "Worker 回合结束但没有通过独立完成校验，任务保持 Blocked",
          summary || undefined,
        );
        await this.cua.finishExecution(taskId, interruptedCode ? "failed" : "blocked");
      }
    }
  }

  private async abortTurn(
    worker: WorkerRecord,
    active: ActiveWorker,
    code: string,
    message: string,
    alreadyTerminal: boolean,
  ): Promise<void> {
    const taskId = active.taskId;
    const partial = active.textBuffer.trim().slice(0, 4000);
    active.textBuffer = "";
    active.aborting = true;
    try {
      await active.connection.abort(active.sessionId);
    } catch (error) {
      this.logger.warn(`Worker abort RPC failed: ${errorMessage(error)}`);
    }
    if (partial) {
      await this.appendMessage(worker, taskId, "assistant", "event", partial);
    }
    if (active.leaseId) {
      await this.leases.release(worker.vmId, active.leaseId);
      active.leaseId = null;
    }
    if (active.tokenId) await this.tokens.bindTask(active.tokenId, null);
    if (active.cuaTokenId) await this.cuaTokens.bindTask(active.cuaTokenId, null);
    active.taskId = null;
    active.completedTaskAt = null;
    if (taskId) {
      const task = await this.tasks.get(taskId);
      if (
        !alreadyTerminal &&
        task &&
        (task.status === "running" || task.status === "waiting_approval")
      ) {
        await this.tasks.recordWorkerEvent(taskId, "worker.aborted", { code, message });
        await this.tasks.block(taskId, code, message, partial || undefined);
        await this.cua.finishExecution(taskId, "blocked");
      } else if (task?.status === "cancelled") {
        await this.cua.finishExecution(taskId, "cancelled");
      } else if (task?.status === "completed") {
        await this.cua.finishExecution(taskId, "completed");
      }
    }
    await this.workers.updateRuntime(worker.id, {
      status: "idle",
      currentTaskId: null,
      lastHeartbeatAt: nowIso(),
    });
  }

  private async failWorker(
    workerId: string,
    active: ActiveWorker,
    code: string,
    message: string,
    taskOutcome: "fail" | "block" = "fail",
  ): Promise<void> {
    const worker = await this.workers.getWorker(workerId);
    if (!worker) return;
    active.unsubscribe();
    this.active.delete(workerId);
    if (active.leaseId) await this.leases.release(worker.vmId, active.leaseId);
    if (active.tokenId) await this.tokens.revoke(active.tokenId, code);
    await this.cuaTokens.revoke(active.cuaTokenId, code);
    if (active.taskId) {
      const task = await this.tasks.get(active.taskId);
      if (task && (task.status === "running" || task.status === "waiting_approval")) {
        await this.tasks.recordWorkerEvent(active.taskId, "worker.failed", { code, message });
        if (taskOutcome === "block") {
          await this.tasks.block(active.taskId, code, message, message);
          await this.cua.finishExecution(active.taskId, "blocked");
        } else {
          await this.tasks.fail(active.taskId, code, message);
          await this.cua.finishExecution(active.taskId, "failed");
        }
      } else {
        await this.cua.finishExecution(active.taskId, "failed");
      }
    }
    await this.workers.updateRuntime(workerId, {
      status: "failed",
      currentTaskId: null,
      lastErrorCode: code,
      lastErrorMessage: message.slice(0, 2000),
      lastHeartbeatAt: null,
      brokerTokenId: null,
    });
  }

  private async reconcileRestart(): Promise<void> {
    const stale = await this.db
      .selectFrom("workers")
      .selectAll()
      .where("status", "in", ["starting", "running", "idle"])
      .execute();
    for (const row of stale) {
      await this.workers.updateRuntime(row.id, {
        status: "failed",
        currentTaskId: null,
        lastHeartbeatAt: null,
        brokerTokenId: null,
        lastErrorCode: "control_plane_restarted",
        lastErrorMessage: "控制平面重启；Guest Pi 进程状态未知，绑定已保留，可显式恢复会话",
      });
      await this.cuaTokens.revokeWorker(row.id, "control_plane_restarted");
      const taskId = row.current_task_id;
      if (taskId) {
        const task = await this.tasks.get(taskId);
        if (task && (task.status === "running" || task.status === "waiting_approval")) {
          await this.tasks.recordWorkerEvent(taskId, "worker.runtime_restarted", {
            workerId: row.id,
          });
          await this.tasks.fail(
            taskId,
            "worker_runtime_restarted",
            "控制平面重启导致 Worker 回合中断；不会假定旧桌面动作成功，请重试",
          );
        }
        const lease = await this.leaseRepository.getByVm(row.vm_id);
        if (lease && lease.taskId === taskId) await this.leases.release(row.vm_id, lease.id);
        await this.cua.finishExecution(taskId, "failed");
      }
    }
  }

  private scheduleTick(): void {
    if (this.stopped) return;
    setTimeout(() => void this.tick(), 0).unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const workers = await this.workers.listActive(undefined, 200);
      for (const worker of workers) {
        const active = this.active.get(worker.id);
        if (!active) continue;
        await this.reconcileActive(worker, active);
      }
      for (const worker of workers) {
        if (worker.status !== "idle" || this.active.get(worker.id)?.taskId) continue;
        await this.claimAndRun(worker);
      }
    } catch (error) {
      this.logger.error(`Worker tick failed: ${errorMessage(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileActive(worker: WorkerRecord, active: ActiveWorker): Promise<void> {
    const now = Date.now();
    if (active.taskId) {
      const task = await this.tasks.get(active.taskId);
      if (task && ["running", "waiting_approval"].includes(task.status)) {
        const expired = await this.cua.expireIfNeeded(task.id);
        if (expired) {
          await this.abortTurn(
            worker,
            active,
            "cua_execution_timeout",
            "任务超过最大执行时间，Worker 已停止工具执行",
            true,
          );
          return;
        }
        active.completedTaskAt = null;
      } else if (task?.status === "completed") {
        // The completion verifier already closed the task. Let Pi settle
        // normally; only force it down if the turn hangs after completion.
        active.completedTaskAt ??= now;
        if (now - active.completedTaskAt > 60_000) {
          await this.abortTurn(
            worker,
            active,
            "task_completed",
            "任务已完成，Worker 回合结束",
            true,
          );
          return;
        }
      } else {
        const reason =
          task?.status === "cancelled"
            ? "任务已取消，Worker 已停止工具执行"
            : "任务已离开运行状态，Worker 已停止";
        await this.abortTurn(worker, active, "task_cancelled", reason, true);
        return;
      }
    }
    const vm = await this.db
      .selectFrom("vm_instances")
      .select("power_state")
      .where("id", "=", worker.vmId)
      .executeTakeFirst();
    if (vm?.power_state !== "running") {
      await this.failWorker(
        worker.id,
        active,
        "worker_vm_stopped",
        "目标 VM 已停止；任务已 Blocked，启动 VM 后可重新排队并重新观察",
        "block",
      );
      return;
    }
    if (now - active.lastHeartbeatAt >= this.heartbeatIntervalMs) {
      try {
        await active.connection.session(active.sessionId);
        active.heartbeatFailures = 0;
        active.lastHeartbeatAt = now;
        await this.workers.updateRuntime(worker.id, { lastHeartbeatAt: nowIso() });
        if (!active.aborting && now - active.lastRenewAt >= 30_000) {
          await Promise.all([
            this.tokens.renew(active.tokenId),
            this.cuaTokens.renew(active.cuaTokenId),
          ]);
          active.lastRenewAt = now;
        }
        if (active.leaseId && now - active.lastLeaseRenewAt >= 10_000) {
          await this.leases.renew(active.leaseId, 30_000);
          active.lastLeaseRenewAt = now;
        }
      } catch (error) {
        active.heartbeatFailures += 1;
        if (active.heartbeatFailures >= this.heartbeatFailureThreshold) {
          await this.failWorker(worker.id, active, "worker_rpc_disconnected", errorMessage(error));
        }
      }
    }
  }

  private async claimAndRun(worker: WorkerRecord): Promise<void> {
    if (worker.status !== "idle") return;
    const vm = await this.db
      .selectFrom("vm_instances")
      .select("power_state")
      .where("id", "=", worker.vmId)
      .executeTakeFirst();
    if (vm?.power_state !== "running") return;
    const claimed = await this.tasks.claimNext(worker.vmId, worker.id);
    if (!claimed) return;
    const active = this.active.get(worker.id);
    if (!active) {
      await this.tasks.fail(claimed.id, "worker_not_connected", "任务认领后 Worker 会话不存在");
      return;
    }
    try {
      const lease = await this.leases.acquire({
        vmId: worker.vmId,
        owner: "worker",
        taskId: claimed.id,
      });
      active.leaseId = lease.id;
      active.taskId = claimed.id;
      active.textBuffer = "";
      active.completedTaskAt = null;
      active.lastLeaseRenewAt = Date.now();
      await Promise.all([
        this.tokens.bindTask(active.tokenId, claimed.id),
        this.cuaTokens.bindTask(active.cuaTokenId, claimed.id),
      ]);
      await this.cua.startExecution({
        taskId: claimed.id,
        workerId: worker.id,
        vmId: worker.vmId,
      });
      await this.workers.updateRuntime(worker.id, {
        status: "running",
        currentTaskId: claimed.id,
        lastHeartbeatAt: nowIso(),
      });
      await this.ensureUserMessage(worker, claimed.id);
      await this.tasks.recordWorkerEvent(claimed.id, "worker.turn_started", {
        workerId: worker.id,
      });
      await active.connection.prompt(active.sessionId, { text: claimed.objective });
    } catch (error) {
      if (active.leaseId) {
        await this.leases.release(worker.vmId, active.leaseId);
        active.leaseId = null;
      }
      if (active.tokenId) await this.tokens.bindTask(active.tokenId, null);
      if (active.cuaTokenId) await this.cuaTokens.bindTask(active.cuaTokenId, null);
      active.taskId = null;
      const task = await this.tasks.get(claimed.id);
      if (task && task.status === "running") {
        if (error instanceof PersistenceError && error.code === "lease_conflict") {
          await this.tasks.block(
            claimed.id,
            "human_control_active",
            "人工正在控制该 VM，任务等待用户恢复",
          );
          await this.cua.finishExecution(claimed.id, "blocked");
        } else {
          await this.tasks.fail(claimed.id, "worker_prompt_failed", errorMessage(error));
          await this.cua.finishExecution(claimed.id, "failed");
        }
      }
      await this.workers.updateRuntime(worker.id, {
        status: "idle",
        currentTaskId: null,
      });
    }
  }

  private async ensureUserMessage(worker: WorkerRecord, taskId: string): Promise<void> {
    const existing = await this.db
      .selectFrom("conversation_messages")
      .select("id")
      .where("task_id", "=", taskId)
      .where("role", "=", "user")
      .executeTakeFirst();
    if (existing) return;
    const task = await this.tasks.get(taskId);
    if (!task) return;
    await this.appendMessage(worker, taskId, "user", "prompt", task.objective);
  }

  private async appendMessage(
    worker: WorkerRecord,
    taskId: string | null,
    role: "user" | "assistant",
    mode: ConversationMessageRecord["mode"],
    content: string,
  ): Promise<void> {
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("conversation_messages")
        .values({
          id: randomUUID(),
          conversation_id: worker.conversationId,
          worker_id: worker.id,
          task_id: taskId,
          role,
          mode,
          content: content.slice(0, 100_000),
          created_at: now,
        })
        .execute();
      await trx
        .updateTable("conversations")
        .set({ last_message_at: now })
        .where("id", "=", worker.conversationId)
        .execute();
    });
    await this.outbox.append("worker.message", { workerId: worker.id, taskId, role }, now);
  }
}

function validatePromptText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 100_000) {
    throw new PersistenceError("validation_failed", "Worker 消息必须为 1～100000 个字符");
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
