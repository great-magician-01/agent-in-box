import { createHash, randomUUID } from "node:crypto";
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
  WorkerRpcClient,
  type WorkerEngineEvent,
  type WorkerInput,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type {
  ActiveTaskCard,
  ConversationMessageRecord,
  GuestHealthState,
  VmPowerState,
  WorkerArchiveArtifactRef,
  WorkerArchiveRecord,
  WorkerArchiveSource,
  WorkerRestorePoint,
  WorkerCreateRequest,
  WorkerLifecyclePolicy,
  WorkerModelSwitchRequest,
  WorkerPromptRequest,
  WorkerRecord,
  WorkerRestoreMode,
  WorkerResumeContextRecord,
  WorkerResumeEnvironment,
  WorkerResumeMode,
  WorkerResumeRequest,
  WorkerResumeResult,
  WorkerRuntimeView,
  WorkerSteerResult,
  WorkerView,
} from "@agent-in-box/protocol";
import { isTaskStatus } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { toProjectRecord } from "../persistence/mappers";
import { DatabaseService } from "../persistence/database.service";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
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
import { SettingsService } from "../settings/settings.service";
import { SupervisorClient } from "../vms/supervisor.client";
import { GuestService } from "../vms/guest.service";
import { WorkerRegistryService } from "./worker-registry.service";

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
  workerLifecyclePolicy?: WorkerLifecyclePolicy;
  idleCheckIntervalMs?: number;
  resumeContextRoot?: string;
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
  contextInjection: boolean;
  restoreMode: WorkerRestoreMode | null;
  restoredAt: string | null;
  heartbeatFailures: number;
  lastHeartbeatAt: number;
  lastRenewAt: number;
  lastLeaseRenewAt: number;
  completedTaskAt: number | null;
}

interface CapturedResumeContext {
  record: WorkerResumeContextRecord;
  imageBase64: string | null;
  injected: boolean;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are an Agent-in-Box Worker running inside the guest VM.",
  "Operate the guest desktop with the vm_* Computer Use tools when the task requires it.",
  "The current task is provided by the host. Use the guest workspace for files.",
  "Never request or expose host credentials, the VM Supervisor, the Model Broker key, or host filesystem paths.",
  "If the guest is locked or shows a UAC/secure desktop, stop and report that human takeover is required.",
  "If the task cannot be completed safely, explain the blocker in your final message.",
].join("\n");

function systemPromptForOs(base: string, osFamily: string): string {
  const name = osFamily === "windows" ? "Windows" : "Linux";
  return base.includes("inside the guest VM")
    ? base.replace("inside the guest VM", `inside the ${name} VM`)
    : base;
}

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
  private readonly lifecyclePolicyOverride?: WorkerLifecyclePolicy;
  private readonly idleCheckIntervalMs: number;
  private readonly resumeContextRoot: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private lastIdleCheckAt = 0;

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
    private readonly archives: WorkerArchiveRepository,
    private readonly registry: WorkerRegistryService,
    private readonly guest: GuestService,
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
    @Optional() @Inject(WORKER_RUNTIME_OPTIONS) options: WorkerRuntimeOptions = {},
  ) {
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? 750);
    this.heartbeatIntervalMs = Math.max(1000, options.heartbeatIntervalMs ?? 10_000);
    this.heartbeatFailureThreshold = Math.max(1, options.heartbeatFailureThreshold ?? 3);
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.now = options.now ?? (() => new Date());
    this.idleCheckIntervalMs = Math.max(1000, options.idleCheckIntervalMs ?? 10_000);
    if (options.workerLifecyclePolicy) this.lifecyclePolicyOverride = options.workerLifecyclePolicy;
    this.resumeContextRoot =
      options.resumeContextRoot ?? path.join(database.layout.archives, "resume-contexts");
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
      .selectAll()
      .where("id", "=", input?.projectId)
      .executeTakeFirst();
    if (!project) throw new PersistenceError("not_found", `项目不存在：${input?.projectId}`);
    if (project.archived_at) throw new PersistenceError("conflict", "已归档项目不能创建 Worker");
    const mcpEnabled = toProjectRecord(project).agentConfig.mcpEnabled;
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
    const archive = input.restoreArchiveId
      ? await this.requireArchiveForRestore(input.restoreArchiveId, input.projectId, input.vmId)
      : undefined;
    const conversationInput =
      archive && !input.conversationId
        ? { ...input, conversationId: archive.conversationId }
        : input;
    const conversationId = await this.resolveConversation(conversationInput);
    if (!archive && input.forceNew !== true) {
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
        systemPrompt: archive
          ? summarySystemPrompt(systemPromptForOs(this.systemPrompt, vm.osFamily), archive.summary)
          : systemPromptForOs(this.systemPrompt, vm.osFamily),
        capabilities: ["computer_use"],
        mcpEnabled,
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
      if (archive) {
        await this.restoreContext(worker, binding.guest_workspace_path, archive, "summary", null);
        this.scheduleTick();
        return this.get(worker.id);
      }
      this.scheduleTick();
      return this.view(updated ?? worker);
    } catch (error) {
      this.detachActive(worker.id);
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
    await this.recordInput(workerId, "steer", text, disposition);
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
    await this.recordInput(workerId, "follow_up", text, disposition);
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

  async archive(
    workerId: string,
    options: { source?: WorkerArchiveSource; reason?: string } = {},
  ): Promise<WorkerView> {
    const worker = await this.requireWorker(workerId);
    const active = this.active.get(workerId);
    if (!active) throw new PersistenceError("conflict", "Worker 会话未连接，无法安全归档");
    if (active.taskId) throw new PersistenceError("conflict", "Worker 仍有运行任务，不能归档");
    if (active.leaseId) {
      throw new PersistenceError("conflict", "Worker 仍持有 Execution Lease，不能归档");
    }
    if (active.contextInjection) {
      throw new PersistenceError("conflict", "Worker 正在注入恢复上下文，不能归档");
    }
    const blockers = await this.registry.archiveBlockers(workerId);
    if (blockers.blocked) {
      throw new PersistenceError("conflict", `Worker 归档被阻止：${blockers.reasons.join("；")}`);
    }
    const binding = await this.db
      .selectFrom("project_vm_bindings")
      .select(["guest_workspace_path"])
      .where("project_id", "=", worker.projectId)
      .where("vm_id", "=", worker.vmId)
      .executeTakeFirst();
    const restorePoint = await this.buildRestorePoint(
      worker,
      binding?.guest_workspace_path ?? null,
    );
    const artifacts = await this.collectArtifacts(workerId);
    await this.workers.updateRuntime(workerId, { status: "archiving", currentTaskId: null });
    let archived: { archiveRef: string; summary: string };
    try {
      archived = await active.connection.archive(active.sessionId);
    } catch (error) {
      await this.workers.updateRuntime(workerId, { status: "idle", currentTaskId: null });
      throw new PersistenceError(
        "unavailable",
        `Worker 会话归档失败，未修改归档状态：${errorMessage(error)}`,
      );
    }
    const summary = await this.combineArchiveSummary(worker, archived.summary, restorePoint);
    active.unsubscribe();
    this.active.delete(workerId);
    await Promise.all([
      this.tokens.revoke(active.tokenId, "worker_archived"),
      this.cuaTokens.revoke(active.cuaTokenId, "worker_archived"),
    ]);
    if (active.leaseId) await this.leases.release(worker.vmId, active.leaseId);
    let updated: WorkerRecord | undefined;
    try {
      const archive = await this.archives.create({
        workerId,
        projectId: worker.projectId,
        vmId: worker.vmId,
        conversationId: worker.conversationId,
        archiveRef: archived.archiveRef,
        engineType: worker.engineType,
        engineVersion: worker.engineVersion,
        sessionVersion: worker.sessionVersion ?? PI_SESSION_FORMAT_VERSION,
        summary,
        restorePoint,
        artifacts,
        source: options.source ?? "manual",
      });
      updated = await this.workers.updateRuntime(workerId, {
        status: "archived",
        currentTaskId: null,
        agentSessionRef: archived.archiveRef,
        archiveSummary: summary,
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
        {
          workerId,
          summaryRef: archived.archiveRef,
          archiveId: archive.id,
          source: archive.source,
        },
        nowIso(),
      );
    } catch (error) {
      // The Guest session is already stopped. Persist an explicit failure instead
      // of leaving the Worker stuck in "archiving" with no live session.
      await this.workers.updateRuntime(workerId, {
        status: "failed",
        currentTaskId: null,
        lastErrorCode: "worker_archive_persist_failed",
        lastErrorMessage: errorMessage(error),
      });
      throw new PersistenceError(
        "unavailable",
        `Worker 已停止但归档记录写入失败：${errorMessage(error)}`,
      );
    }
    // updateRuntime was read before archived_at was written, so re-read the row
    // to return the same archive state a subsequent GET would report.
    const final = (await this.workers.getWorker(workerId)) ?? updated ?? worker;
    return this.view(final);
  }

  async switchModel(workerId: string, input: WorkerModelSwitchRequest): Promise<WorkerView> {
    const worker = await this.requireWorker(workerId);
    if (worker.status !== "idle") {
      throw new PersistenceError("conflict", "只有空闲 Worker 可以切换模型");
    }
    const active = this.active.get(workerId);
    if (!active) throw new PersistenceError("conflict", "Worker 会话未连接");
    if (
      typeof input?.providerId !== "string" ||
      !input.providerId.trim() ||
      typeof input.model !== "string" ||
      !input.model.trim()
    ) {
      throw new PersistenceError("validation_failed", "切换模型必须指定 Provider 和模型");
    }
    // Validate the target before archiving so an invalid selection cannot stop
    // the current Worker.
    const model = await this.providers.resolve(
      input.providerId.trim(),
      input.model.trim(),
      "worker",
    );
    await this.archive(workerId, { source: "manual", reason: "model_switch" });
    try {
      return await this.create({
        projectId: worker.projectId,
        vmId: worker.vmId,
        conversationId: worker.conversationId,
        providerId: model.provider.id,
        model: model.model.id,
        forceNew: true,
      });
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `旧 Worker 已归档，但新模型会话启动失败：${errorMessage(error)}`,
      );
    }
  }

  async resume(workerId: string, request: WorkerResumeRequest = {}): Promise<WorkerResumeResult> {
    const worker = await this.requireWorker(workerId);
    if (this.active.has(workerId)) throw new PersistenceError("conflict", "Worker 已经连接");
    if (worker.status !== "archived" && worker.status !== "failed") {
      throw new PersistenceError("conflict", `Worker 状态 ${worker.status} 不能恢复`);
    }
    const mode = normalizeResumeMode(request.mode);
    const archive = await this.archives.latestForWorker(workerId, "available");
    const nativeRef = worker.agentSessionRef ?? archive?.archiveRef ?? null;
    const summaryText = archive?.summary ?? worker.archiveSummary ?? null;
    const nativeCompatible =
      worker.engineType === "pi-rpc" &&
      worker.engineVersion === PI_ENGINE_VERSION &&
      (worker.sessionVersion === null || worker.sessionVersion === PI_SESSION_FORMAT_VERSION) &&
      (!archive ||
        (archive.engineVersion === PI_ENGINE_VERSION &&
          archive.sessionVersion === PI_SESSION_FORMAT_VERSION));
    let restoreMode: WorkerRestoreMode;
    let notice: string | null = null;
    if (mode === "native") {
      if (!nativeRef) throw new PersistenceError("conflict", "Worker 没有可恢复的原生会话");
      if (!nativeCompatible) {
        throw new PersistenceError(
          "conflict",
          `原生会话版本不兼容：要求 Pi ${PI_ENGINE_VERSION} / Session ${PI_SESSION_FORMAT_VERSION}`,
        );
      }
      restoreMode = "native";
    } else if (mode === "summary") {
      if (!summaryText) throw new PersistenceError("conflict", "Worker 没有可用的归档摘要");
      restoreMode = "summary";
    } else if (nativeRef && nativeCompatible) {
      restoreMode = "native";
    } else if (summaryText) {
      restoreMode = "summary";
      notice = nativeRef
        ? `原生会话版本不兼容（engine=${worker.engineVersion}, session=${worker.sessionVersion ?? "未知"}），已按归档摘要创建新的 Agent Session`
        : "Worker 没有可恢复的原生会话，已按归档摘要创建新的 Agent Session";
    } else {
      throw new PersistenceError("conflict", "Worker 没有可恢复的会话引用或摘要");
    }
    const [binding, vm, model, project] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .select(["guest_workspace_path"])
        .where("project_id", "=", worker.projectId)
        .where("vm_id", "=", worker.vmId)
        .executeTakeFirst(),
      this.requireVm(worker.vmId),
      this.providers.resolve(worker.providerId ?? undefined, worker.modelId ?? undefined),
      this.db
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", worker.projectId)
        .executeTakeFirstOrThrow(),
    ]);
    if (!binding) throw new PersistenceError("conflict", "目标 VM 已解绑，不能恢复 Worker");
    if (vm.powerState !== "running") throw new PersistenceError("conflict", "目标 VM 未运行");
    const runtime = await this.supervisor.get(worker.vmId);
    if (!runtime.workerHostPort) {
      throw new PersistenceError("unavailable", "VM 没有 Worker RPC 端口");
    }
    await this.workers.updateRuntime(workerId, {
      status: worker.status === "failed" ? "starting" : "restoring",
      currentTaskId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    const target: WorkerGuestTarget = {
      workerId,
      vmId: worker.vmId,
      hostPort: runtime.workerHostPort,
      storageRoot: vm.storageRoot,
    };
    let connection = this.connectorFactory(target);
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
      const baseSpec = this.sessionSpec(
        worker,
        binding.guest_workspace_path,
        model.provider.id,
        model.model.id,
        token.token,
        cuaToken.token,
        model.provider.api,
        model.model.reasoning === true,
        restoreMode === "summary" && summaryText
          ? summarySystemPrompt(this.systemPrompt, summaryText)
          : undefined,
        toProjectRecord(project).agentConfig.mcpEnabled,
      );
      let handle: WorkerSessionHandle;
      if (restoreMode === "native" && nativeRef) {
        try {
          handle = await connection.resume(nativeRef, baseSpec);
        } catch (error) {
          if (mode !== "auto" || !summaryText) throw error;
          restoreMode = "summary";
          notice = `原生会话恢复失败（${errorMessage(error)}），已按归档摘要创建新的 Agent Session`;
          connection = this.connectorFactory(target);
          handle = await connection.startSession({
            ...baseSpec,
            systemPrompt: summarySystemPrompt(this.systemPrompt, summaryText),
          });
        }
      } else {
        handle = await connection.startSession(baseSpec);
      }
      await Promise.all([
        this.tokens.bindSession(token.context.id, handle.sessionId),
        this.cuaTokens.bindSession(cuaToken.context.id, handle.sessionId),
      ]);
      await this.workers.updateRuntime(workerId, {
        status: "idle",
        currentTaskId: null,
        agentSessionRef: handle.archiveRef ?? nativeRef,
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
      const context = await this.restoreContext(
        worker,
        binding.guest_workspace_path,
        archive ?? null,
        restoreMode,
        notice,
      );
      if (archive) await this.archives.markRestored(archive.id);
      if (!context.injected) {
        notice = `${notice ? `${notice}；` : ""}恢复环境注入失败，请在下一回合先调用 vm_screenshot 重新观察`;
      }
      this.logger.log(
        `Worker ${workerId} restored with ${restoreMode} session${notice ? `: ${notice}` : ""}`,
      );
      await this.outbox.append(
        "worker.resumed",
        {
          workerId,
          restoreMode,
          archiveId: archive?.id ?? null,
          notice,
        },
        nowIso(),
      );
      this.scheduleTick();
      return {
        worker: await this.get(workerId),
        restoreMode,
        context: context.record,
        notice,
      };
    } catch (error) {
      this.detachActive(workerId);
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

  private detachActive(workerId: string): void {
    const active = this.active.get(workerId);
    if (!active) return;
    active.unsubscribe();
    this.active.delete(workerId);
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

  private async requireArchiveForRestore(
    archiveId: string,
    projectId: string,
    vmId: string,
  ): Promise<WorkerArchiveRecord> {
    const archive = await this.archives.get(archiveId);
    if (!archive) throw new PersistenceError("not_found", `归档不存在：${archiveId}`);
    if (archive.projectId !== projectId || archive.vmId !== vmId) {
      throw new PersistenceError("validation_failed", "归档不属于目标项目或 VM");
    }
    return archive;
  }

  private async restoreContext(
    worker: WorkerRecord,
    workspacePath: string,
    archive: WorkerArchiveRecord | null,
    restoreMode: WorkerRestoreMode,
    notice: string | null,
  ): Promise<CapturedResumeContext> {
    const environment = await this.buildResumeEnvironment(worker, workspacePath, archive);
    const contextId = randomUUID();
    const createdAt = nowIso();
    let imageBase64: string | null = null;
    let screenshot: WorkerResumeContextRecord["screenshot"] = null;
    let screenshotPath: string | null = null;
    try {
      const observed = await this.guest.observe(worker.vmId);
      const bytes = Buffer.from(observed.screenshot.dataBase64, "base64");
      if (bytes.byteLength > 0) {
        const hash = createHash("sha256").update(bytes).digest("hex");
        // Keep the base64 payload well below the 16 MiB Worker RPC body cap.
        if (bytes.byteLength <= 8 * 1024 * 1024) {
          await mkdir(this.resumeContextRoot, { recursive: true, mode: 0o700 });
          const file = path.join(
            this.resumeContextRoot,
            `${worker.id}-${Date.now()}-${randomUUID()}.png`,
          );
          await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
          screenshotPath = file;
          imageBase64 = observed.screenshot.dataBase64;
        }
        screenshot = {
          width: observed.screenshot.width,
          height: observed.screenshot.height,
          sha256: hash,
          capturedAt: observed.screenshot.capturedAt,
        };
      }
    } catch (error) {
      this.logger.warn(
        `Worker resume screenshot unavailable for ${worker.id}: ${errorMessage(error)}`,
      );
    }
    await this.db
      .insertInto("worker_resume_contexts")
      .values({
        id: contextId,
        worker_id: worker.id,
        archive_id: archive?.id ?? null,
        restore_mode: restoreMode,
        screenshot_path: screenshotPath,
        screenshot_sha256: screenshot?.sha256 ?? null,
        screenshot_width: screenshot?.width ?? null,
        screenshot_height: screenshot?.height ?? null,
        environment_json: JSON.stringify(environment),
        created_at: createdAt,
      })
      .execute();
    const record: WorkerResumeContextRecord = {
      id: contextId,
      workerId: worker.id,
      archiveId: archive?.id ?? null,
      restoreMode,
      screenshot,
      environment,
      createdAt,
    };
    const active = this.active.get(worker.id);
    if (!active) {
      return { record, imageBase64, injected: false };
    }
    active.restoreMode = restoreMode;
    active.restoredAt = record.createdAt;
    active.contextInjection = true;
    try {
      await this.workers.updateRuntime(
        worker.id,
        {
          status: "running",
          currentTaskId: null,
        },
        record.createdAt,
      );
      await active.connection.prompt(active.sessionId, {
        text: resumeBrief(restoreMode, environment, notice),
        ...(imageBase64 ? { images: [{ mimeType: "image/png" as const, data: imageBase64 }] } : {}),
      });
      return { record, imageBase64, injected: true };
    } catch (error) {
      this.logger.warn(`Worker resume context injection failed: ${errorMessage(error)}`);
      try {
        await active.connection.abort(active.sessionId);
      } catch {
        // The RPC may already be down; idle state still requires a fresh observation.
      }
      active.contextInjection = false;
      await this.workers.updateRuntime(worker.id, { status: "idle", currentTaskId: null });
      return { record, imageBase64, injected: false };
    }
  }

  private async buildResumeEnvironment(
    worker: WorkerRecord,
    workspacePath: string,
    archive: WorkerArchiveRecord | null,
  ): Promise<WorkerResumeEnvironment> {
    const archivedAt = archive?.createdAt ?? worker.archivedAt;
    const [vm, tasks, sharedBindings] = await Promise.all([
      this.db
        .selectFrom("vm_instances")
        .select(["name", "power_state", "guest_health"])
        .where("id", "=", worker.vmId)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom("tasks")
        .selectAll()
        .where("project_id", "=", worker.projectId)
        .where("vm_id", "=", worker.vmId)
        .orderBy("updated_at", "desc")
        .limit(10)
        .execute(),
      this.db
        .selectFrom("project_vm_bindings")
        .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
        .select([
          "projects.id as id",
          "projects.name as name",
          "projects.archived_at as archived_at",
        ])
        .where("project_vm_bindings.vm_id", "=", worker.vmId)
        .where("project_vm_bindings.project_id", "!=", worker.projectId)
        .orderBy("projects.created_at", "asc")
        .execute(),
    ]);
    const activeTaskIds = tasks
      .filter((task) => ["running", "waiting_approval", "blocked"].includes(task.status))
      .map((task) => task.id);
    const sharedProjectIds = sharedBindings.map((project) => project.id);
    const [sharedTasks, ownActivities, sharedActivities] = await Promise.all([
      this.db
        .selectFrom("tasks")
        .select(["project_id", "status", "updated_at", "objective"])
        .where("vm_id", "=", worker.vmId)
        .where("project_id", "in", sharedProjectIds.length > 0 ? sharedProjectIds : [""])
        .where("status", "in", [
          "created",
          "waiting_resources",
          "waiting_vm",
          "queued",
          "running",
          "waiting_approval",
          "blocked",
        ])
        .execute(),
      archivedAt
        ? this.db
            .selectFrom("project_activities")
            .select(["type", "created_at"])
            .where("project_id", "=", worker.projectId)
            .where("created_at", ">", archivedAt)
            .orderBy("created_at", "desc")
            .limit(50)
            .execute()
        : Promise.resolve([]),
      archivedAt && sharedProjectIds.length > 0
        ? this.db
            .selectFrom("project_activities")
            .select(["project_id", "type", "created_at"])
            .where("project_id", "in", sharedProjectIds)
            .where("created_at", ">", archivedAt)
            .orderBy("created_at", "desc")
            .limit(100)
            .execute()
        : Promise.resolve([]),
    ]);
    const changesSinceArchive: string[] = [];
    const restorePoint = archive?.restorePoint ?? null;
    if (restorePoint && restorePoint.vmPowerState !== vm.power_state) {
      changesSinceArchive.push(
        `VM 电源状态从 ${restorePoint.vmPowerState} 变为 ${vm.power_state}。`,
      );
    }
    const ownNewTasks = archivedAt ? tasks.filter((task) => task.created_at > archivedAt) : [];
    if (ownNewTasks.length > 0) {
      changesSinceArchive.push(
        `本项目在本 VM 上新增 ${ownNewTasks.length} 个任务：${ownNewTasks
          .slice(0, 3)
          .map((task) => `${task.objective.slice(0, 80)}（${task.status}）`)
          .join("；")}`,
      );
    }
    if (ownActivities.length > 0) {
      const counts = new Map<string, number>();
      for (const activity of ownActivities) {
        counts.set(activity.type, (counts.get(activity.type) ?? 0) + 1);
      }
      const summary = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => `${type}×${count}`)
        .join("、");
      changesSinceArchive.push(
        `本项目离开期间记录到最近 ${ownActivities.length} 条项目活动（${summary}）。`,
      );
    }
    for (const project of sharedBindings) {
      const projectActivities = sharedActivities.filter(
        (activity) => activity.project_id === project.id,
      );
      const projectTasks = sharedTasks.filter((task) => task.project_id === project.id);
      if (projectActivities.length === 0 && projectTasks.length === 0) continue;
      changesSinceArchive.push(
        `共享 VM 上的项目「${project.name}」离开期间记录到最近 ${projectActivities.length} 条活动和 ${projectTasks.length} 个未结束任务；其桌面输入与文件变化可能与你的记忆不同。`,
      );
    }
    if (changesSinceArchive.length === 0 && archivedAt) {
      changesSinceArchive.push("离开期间未记录到本项目或共享 VM 上其他项目的环境变化。");
    }
    return {
      vmId: worker.vmId,
      vmName: vm.name,
      powerState: vm.power_state as VmPowerState,
      guestHealth: vm.guest_health as GuestHealthState,
      workspacePath,
      activeTaskIds,
      recentTasks: tasks.map((task) => ({
        id: task.id,
        objective: task.objective.slice(0, 500),
        status: (isTaskStatus(task.status) ? task.status : "blocked") as ActiveTaskCard["status"],
        latestSummary: task.latest_summary ? task.latest_summary.slice(0, 500) : null,
        updatedAt: task.updated_at,
      })),
      archivedAt,
      archivedForMs: archivedAt
        ? Math.max(0, this.now().getTime() - new Date(archivedAt).getTime())
        : null,
      sharedVm: sharedBindings.length > 0,
      sharedProjects: sharedBindings.map((project) => ({
        id: project.id,
        name: project.name,
        archived: project.archived_at !== null,
        activeTaskCount: sharedTasks.filter((task) => task.project_id === project.id).length,
      })),
      changesSinceArchive: changesSinceArchive.map((line) => line.slice(0, 600)).slice(0, 12),
      capturedAt: nowIso(),
    };
  }

  private async buildRestorePoint(
    worker: WorkerRecord,
    workspacePath: string | null,
  ): Promise<WorkerRestorePoint | null> {
    const [vm, tasks, lastMessage] = await Promise.all([
      this.db
        .selectFrom("vm_instances")
        .select(["power_state", "guest_health"])
        .where("id", "=", worker.vmId)
        .executeTakeFirst(),
      this.db
        .selectFrom("tasks")
        .select(["id", "status"])
        .where("assigned_worker_id", "=", worker.id)
        .orderBy("updated_at", "desc")
        .limit(100)
        .execute(),
      this.db
        .selectFrom("conversation_messages")
        .select("created_at")
        .where("worker_id", "=", worker.id)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);
    if (!vm) return null;
    const latest = tasks[0];
    return {
      vmPowerState: vm.power_state as VmPowerState,
      guestHealth: vm.guest_health as GuestHealthState,
      workspacePath: workspacePath ?? "",
      taskIds: tasks.map((task) => task.id),
      taskCount: tasks.length,
      latestTaskStatus: latest && isTaskStatus(latest.status) ? latest.status : null,
      lastMessageAt: lastMessage?.created_at ?? null,
      capturedAt: nowIso(),
    };
  }

  private async collectArtifacts(workerId: string): Promise<WorkerArchiveArtifactRef[]> {
    const rows = await this.db
      .selectFrom("task_artifacts")
      .innerJoin("tasks", "tasks.id", "task_artifacts.task_id")
      .select([
        "task_artifacts.task_id as task_id",
        "task_artifacts.name as name",
        "task_artifacts.relative_path as relative_path",
        "task_artifacts.sha256 as sha256",
        "task_artifacts.size_bytes as size_bytes",
      ])
      .where("tasks.assigned_worker_id", "=", workerId)
      .orderBy("task_artifacts.created_at", "desc")
      .limit(100)
      .execute();
    return rows.map((row) => ({
      taskId: row.task_id,
      name: row.name,
      relativePath: row.relative_path,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    }));
  }

  private async combineArchiveSummary(
    worker: WorkerRecord,
    guestSummary: string,
    restorePoint: WorkerRestorePoint | null,
  ): Promise<string> {
    const [messages, tasks] = await Promise.all([
      this.db
        .selectFrom("conversation_messages")
        .select(["role", "content"])
        .where("worker_id", "=", worker.id)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(12)
        .execute(),
      this.db
        .selectFrom("tasks")
        .select(["objective", "status", "latest_summary"])
        .where("assigned_worker_id", "=", worker.id)
        .orderBy("updated_at", "desc")
        .limit(5)
        .execute(),
    ]);
    const recent = messages.reverse().map((message) => {
      const role = message.role === "user" ? "User" : "Worker";
      return `${role}: ${message.content.slice(0, 300)}`;
    });
    const taskLines = tasks.map(
      (task) =>
        `- [${task.status}] ${task.objective.slice(0, 200)}${
          task.latest_summary ? ` — ${task.latest_summary.slice(0, 300)}` : ""
        }`,
    );
    const parts = [
      guestSummary.trim(),
      restorePoint
        ? `Environment: VM ${restorePoint.vmPowerState}, tasks=${restorePoint.taskCount}, workspace=${restorePoint.workspacePath || "unknown"}`
        : "",
      taskLines.length > 0 ? `Recent tasks:\n${taskLines.join("\n")}` : "",
      recent.length > 0 ? `Recent conversation:\n${recent.join("\n")}` : "",
    ].filter(Boolean);
    return parts.join("\n\n").slice(0, 4000);
  }

  private async recordInput(
    workerId: string,
    kind: "steer" | "follow_up",
    content: string,
    disposition: "queued" | "handled",
  ): Promise<void> {
    const now = nowIso();
    await this.db
      .insertInto("worker_inputs")
      .values({
        id: randomUUID(),
        worker_id: workerId,
        kind,
        content: content.slice(0, 100_000),
        status: disposition === "handled" ? "delivered" : "pending",
        created_at: now,
        delivered_at: disposition === "handled" ? now : null,
      })
      .execute();
  }

  private async markInputs(workerId: string, status: "delivered" | "cancelled"): Promise<void> {
    await this.db
      .updateTable("worker_inputs")
      .set({ status, delivered_at: status === "delivered" ? nowIso() : null })
      .where("worker_id", "=", workerId)
      .where("status", "=", "pending")
      .execute();
  }

  private async autoArchiveIdle(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastIdleCheckAt < this.idleCheckIntervalMs) return;
    this.lastIdleCheckAt = now;
    const policy = this.lifecyclePolicyOverride ?? (await this.settings.workerLifecyclePolicy());
    if (!policy.autoArchiveEnabled) return;
    const workers = await this.workers.listActive(undefined, 200);
    for (const worker of workers) {
      if (worker.status !== "idle") continue;
      const active = this.active.get(worker.id);
      if (!active || active.taskId || active.leaseId || active.contextInjection) continue;
      const lastActive = Date.parse(worker.lastActiveAt);
      if (!Number.isFinite(lastActive) || now - lastActive < policy.idleTimeoutMs) continue;
      try {
        await this.archive(worker.id, { source: "auto", reason: "idle_timeout" });
      } catch (error) {
        this.logger.debug(`Worker ${worker.id} was not auto-archived: ${errorMessage(error)}`);
      }
    }
  }

  private view(worker: WorkerRecord): WorkerView {
    const active = this.active.get(worker.id);
    const runtime: WorkerRuntimeView = {
      connected: Boolean(active),
      protocolVersion: active ? "0.1.0" : null,
      engineVersion: worker.engineVersion || null,
      sessionVersion: worker.sessionVersion,
      lastError: worker.lastErrorMessage,
      restoreMode: active?.restoreMode ?? null,
      restoredAt: active?.restoredAt ?? null,
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
    osFamily: string;
  }> {
    const row = await this.db
      .selectFrom("vm_instances")
      .select(["id", "power_state", "storage_root", "os_family"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", `VM 不存在：${vmId}`);
    return {
      id: row.id,
      powerState: row.power_state,
      storageRoot: row.storage_root,
      osFamily: row.os_family,
    };
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
    systemPrompt?: string,
    mcpEnabled = false,
  ): WorkerSessionSpec {
    return {
      workerId: worker.id,
      projectId: worker.projectId,
      vmId: worker.vmId,
      workspacePath,
      engineType: "pi-rpc",
      engineVersion: PI_ENGINE_VERSION,
      sessionVersion: PI_SESSION_FORMAT_VERSION,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      capabilities: ["computer_use"],
      mcpEnabled,
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
      contextInjection: false,
      restoreMode: null,
      restoredAt: null,
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
    active.contextInjection = false;
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
    await this.markInputs(workerId, "delivered");
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
    active.contextInjection = false;
    await this.markInputs(worker.id, "cancelled");
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
    await this.markInputs(workerId, "cancelled");
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
      await this.markInputs(row.id, "cancelled");
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
      await this.autoArchiveIdle();
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
    // Token and Execution Lease renewal must not be gated by the RPC heartbeat.
    // Tool events also refresh lastHeartbeatAt, so a busy Worker can stream
    // events continuously while the 30s lease would otherwise expire and every
    // vm_* call would fail with lease_conflict.
    if (!active.aborting && now - active.lastRenewAt >= 30_000) {
      try {
        await Promise.all([
          this.tokens.renew(active.tokenId),
          this.cuaTokens.renew(active.cuaTokenId),
        ]);
        active.lastRenewAt = now;
      } catch (error) {
        this.logger.warn(`Worker ${worker.id} broker token renewal failed: ${errorMessage(error)}`);
      }
    }
    if (active.leaseId && now - active.lastLeaseRenewAt >= 10_000) {
      try {
        await this.leases.renew(active.leaseId, 30_000);
        active.lastLeaseRenewAt = now;
      } catch (error) {
        this.logger.warn(
          `Worker ${worker.id} execution lease renewal failed: ${errorMessage(error)}`,
        );
      }
    }
    if (now - active.lastHeartbeatAt >= this.heartbeatIntervalMs) {
      try {
        await active.connection.session(active.sessionId);
        active.heartbeatFailures = 0;
        active.lastHeartbeatAt = now;
        await this.workers.updateHeartbeat(worker.id, nowIso());
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

function normalizeResumeMode(value: unknown): WorkerResumeMode {
  if (value === undefined || value === null) return "auto";
  if (value === "auto" || value === "native" || value === "summary") return value;
  throw new PersistenceError("validation_failed", "恢复模式必须是 auto、native 或 summary");
}

function summarySystemPrompt(base: string, summary: string): string {
  return [
    base,
    "",
    "## Archived Worker session summary",
    summary.slice(0, 4000),
    "",
    "This is a semantic restore into a new Agent Session, not a lossless native resume.",
    "The VM environment may have changed since the archive. Do not assume old screenshots or UI state.",
    "Call vm_screenshot before performing any desktop action.",
  ].join("\n");
}

function resumeBrief(
  restoreMode: WorkerRestoreMode,
  environment: WorkerResumeEnvironment,
  notice: string | null,
): string {
  const tasks = environment.recentTasks
    .map((task) => `- [${task.status}] ${task.objective}`)
    .join("\n");
  return [
    `[Agent-in-Box resume context: ${restoreMode}]`,
    notice ?? "",
    `VM: ${environment.vmName} (${environment.vmId}) power=${environment.powerState} health=${environment.guestHealth}`,
    `Workspace: ${environment.workspacePath}`,
    environment.archivedForMs !== null
      ? `Archived for ${Math.round(environment.archivedForMs / 60000)} minutes.`
      : "",
    `Active tasks: ${environment.activeTaskIds.length > 0 ? environment.activeTaskIds.join(", ") : "none"}`,
    tasks ? `Recent tasks:\n${tasks}` : "",
    environment.sharedVm
      ? `Shared VM projects: ${environment.sharedProjects
          .map((project) => `${project.name} (${project.activeTaskCount} active tasks)`)
          .join(", ")}. Other projects may have changed the shared desktop and system state.`
      : "",
    environment.changesSinceArchive.length > 0
      ? `Changes since archive:\n${environment.changesSinceArchive
          .map((change) => `- ${change}`)
          .join("\n")}`
      : "",
    "The attached image is the host's latest observation; it may already be stale.",
    "Do not start or continue any desktop work yet. Call vm_screenshot before any future input,",
    "then reply with one short paragraph acknowledging the restored context.",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
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
