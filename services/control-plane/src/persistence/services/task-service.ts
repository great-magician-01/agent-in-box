import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  Page,
  PageRequest,
  TaskArtifactInput,
  TaskArtifactRecord,
  TaskBoardItem,
  TaskBoardSnapshot,
  TaskCompletionInput,
  TaskDetail,
  TaskListFilters,
  TaskRecord,
  TaskStatus,
} from "@agent-in-box/protocol";
import {
  assertTaskTransition,
  isTerminalTaskStatus,
  normalizeQueuePriority,
} from "@agent-in-box/domain";
import { nowIso } from "../time";
import {
  NotFoundError,
  IdempotencyConflictError,
  InvalidTransitionError,
  PersistenceError,
} from "../errors";
import { KYSELY } from "../tokens";
import type { DatabaseExecutor } from "../executor";
import type { DatabaseSchema } from "../schema";
import { toProjectRecord, toVmInstanceRecord, toWorkerRecord } from "../mappers";
import { OutboxRepository } from "../repositories/outbox-repository";
import { TaskRepository, type TaskUpdatePatch } from "../repositories/task-repository";

export const TASK_SERVICE_OPTIONS = Symbol("AGENT_IN_BOX_TASK_SERVICE_OPTIONS");
export interface TaskServiceOptions {
  artifactRoot?: string;
}

export interface CreateTaskInput {
  projectId: string;
  vmId: string;
  originConversationId?: string;
  objective: string;
  priority?: number;
  parentTaskId?: string | null;
  dependsOn?: string[];
  idempotencyKey: string;
}

export interface CreateTaskResult {
  task: TaskRecord;
  created: boolean;
}

export interface TransitionOptions {
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface VerifiedArtifact extends TaskArtifactInput {
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

@Injectable()
export class TaskService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tasks: TaskRepository,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(TASK_SERVICE_OPTIONS) private readonly options: TaskServiceOptions = {},
  ) {}

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective || objective.length > 4000) {
      throw new PersistenceError("validation_failed", "任务目标必须为 1～4000 个字符");
    }
    const idempotencyKey =
      typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new PersistenceError("validation_failed", "幂等键必须为 1～200 个字符");
    }
    const dependsOn = normalizeDependencyIds(input.dependsOn);
    const normalized = {
      projectId: input.projectId,
      vmId: input.vmId,
      originConversationId: input.originConversationId ?? null,
      objective,
      priority: normalizeQueuePriority(input.priority ?? 0),
      parentTaskId: input.parentTaskId ?? null,
      dependsOn,
    };
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

    return this.db.transaction().execute(async (trx) => {
      const existing = await this.tasks.findIdempotencyKey(idempotencyKey, trx);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyConflictError(idempotencyKey);
        }
        const task = await this.tasks.getTask(existing.taskId, trx);
        if (!task) throw new NotFoundError(`幂等任务不存在：${existing.taskId}`);
        return { task, created: false };
      }

      const project = await trx
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", normalized.projectId)
        .executeTakeFirst();
      if (!project) throw new NotFoundError(`项目不存在：${normalized.projectId}`);
      if (project.archived_at) {
        throw new PersistenceError("conflict", "已归档项目不能创建新任务");
      }
      const binding = await trx
        .selectFrom("project_vm_bindings")
        .select("id")
        .where("project_id", "=", normalized.projectId)
        .where("vm_id", "=", normalized.vmId)
        .executeTakeFirst();
      if (!binding) {
        throw new PersistenceError("validation_failed", "目标 VM 尚未绑定到该项目");
      }
      const vm = await trx
        .selectFrom("vm_instances")
        .selectAll()
        .where("id", "=", normalized.vmId)
        .executeTakeFirst();
      if (!vm) throw new NotFoundError(`目标 VM 不存在：${normalized.vmId}`);

      let originConversationId = normalized.originConversationId;
      if (originConversationId) {
        const conversation = await trx
          .selectFrom("conversations")
          .selectAll()
          .where("id", "=", originConversationId)
          .executeTakeFirst();
        if (
          !conversation ||
          !(
            conversation.project_id === normalized.projectId ||
            (conversation.kind === "router" && conversation.project_id === null)
          )
        ) {
          throw new PersistenceError("validation_failed", "来源会话不属于该项目");
        }
      } else {
        const existingConversation = await trx
          .selectFrom("conversations")
          .select("id")
          .where("project_id", "=", normalized.projectId)
          .where("kind", "=", "project")
          .orderBy("last_message_at", "desc")
          .limit(1)
          .executeTakeFirst();
        if (existingConversation) {
          originConversationId = existingConversation.id;
        } else {
          const now = nowIso();
          originConversationId = randomUUID();
          await trx
            .insertInto("conversations")
            .values({
              id: originConversationId,
              kind: "project",
              project_id: normalized.projectId,
              title: "项目任务会话",
              created_at: now,
              last_message_at: now,
            })
            .execute();
        }
      }

      if (normalized.parentTaskId) {
        const parent = await this.tasks.getTask(normalized.parentTaskId, trx);
        if (!parent || parent.projectId !== normalized.projectId) {
          throw new PersistenceError("validation_failed", "父任务不存在或不属于该项目");
        }
      }
      if (dependsOn.length > 0) {
        const dependencies = await trx
          .selectFrom("tasks")
          .select(["id", "status"])
          .where("id", "in", dependsOn)
          .execute();
        if (dependencies.length !== dependsOn.length) {
          throw new PersistenceError("validation_failed", "一个或多个依赖任务不存在");
        }
      }

      const now = nowIso();
      const dependenciesCompleted = await this.dependenciesCompletedForIds(dependsOn, trx);
      const initialStatus: TaskStatus = !dependenciesCompleted
        ? "created"
        : vm.power_state === "running"
          ? "queued"
          : "waiting_vm";
      const task: TaskRecord = {
        id: randomUUID(),
        projectId: normalized.projectId,
        vmId: normalized.vmId,
        originConversationId,
        assignedWorkerId: null,
        parentTaskId: normalized.parentTaskId,
        objective,
        status: initialStatus,
        priority: normalized.priority,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        latestSummary: dependenciesCompleted ? null : "等待依赖任务完成",
        result: null,
        errorCode: null,
        errorMessage: null,
      };

      await this.tasks.insertTask(task, trx);
      for (const dependencyTaskId of dependsOn) {
        await trx
          .insertInto("task_dependencies")
          .values({ task_id: task.id, dependency_task_id: dependencyTaskId, created_at: now })
          .execute();
      }
      await this.tasks.insertIdempotencyKey(idempotencyKey, task.id, requestHash, now, trx);
      await this.tasks.appendEvent(
        task.id,
        "task.created",
        { task, dependencyIds: dependsOn },
        now,
        trx,
      );
      await this.outbox.append("task.created", { task, dependencyIds: dependsOn }, now, trx);
      await this.appendActivity(task.projectId, "task.created", { taskId: task.id }, now, trx);
      return { task, created: true };
    });
  }

  async transition(
    taskId: string,
    to: TaskStatus,
    options: TransitionOptions = {},
  ): Promise<TaskRecord> {
    if (to === "completed") {
      throw new InvalidTransitionError("完成任务必须通过 complete() 校验结果和产物");
    }
    return this.db
      .transaction()
      .execute(async (trx) => this.transitionInTransaction(taskId, to, options, {}, trx));
  }

  async cancel(taskId: string, reason?: string): Promise<TaskRecord> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.tasks.getTask(taskId, trx);
      if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
      if (current.status === "cancelled") return current;
      if (current.status === "completed" || current.status === "failed") {
        throw new InvalidTransitionError(`任务当前状态 ${current.status} 不能取消`);
      }
      return this.transitionInTransaction(
        taskId,
        "cancelled",
        {
          summary: reason?.trim() || "用户取消任务",
          errorCode: "task_cancelled",
          errorMessage: reason?.trim() || "用户取消任务",
        },
        { result: null },
        trx,
      );
    });
  }

  async retry(taskId: string): Promise<TaskRecord> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.tasks.getTask(taskId, trx);
      if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
      if (current.status !== "failed") {
        throw new InvalidTransitionError("只有失败任务可以重试");
      }
      const [project, binding, vm] = await Promise.all([
        trx
          .selectFrom("projects")
          .select("archived_at")
          .where("id", "=", current.projectId)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom("project_vm_bindings")
          .select("id")
          .where("project_id", "=", current.projectId)
          .where("vm_id", "=", current.vmId)
          .executeTakeFirst(),
        trx
          .selectFrom("vm_instances")
          .select("power_state")
          .where("id", "=", current.vmId)
          .executeTakeFirstOrThrow(),
      ]);
      if (project.archived_at) {
        throw new PersistenceError("conflict", "已归档项目不能重试任务");
      }
      if (!binding) {
        throw new PersistenceError("conflict", "目标 VM 已解绑，不能重试任务");
      }
      const dependenciesReady = await this.dependenciesCompleted(current.id, trx);
      const target: TaskStatus = !dependenciesReady
        ? "created"
        : vm.power_state === "running"
          ? "queued"
          : "waiting_vm";
      return this.transitionInTransaction(
        taskId,
        target,
        {
          summary: !dependenciesReady
            ? "已重试，等待依赖任务完成"
            : target === "queued"
              ? "已重新排队，等待 Worker 认领"
              : "已重试，等待目标 VM 启动",
        },
        {
          assignedWorkerId: null,
          startedAt: null,
          completedAt: null,
          result: null,
          errorCode: null,
          errorMessage: null,
        },
        trx,
      );
    });
  }

  /**
   * Returns a blocked task to the VM queue after the user resolved the blocker.
   * The task keeps its history and evidence; a new Worker turn must observe the
   * VM again, and old desktop actions are never replayed.
   */
  async requeue(taskId: string): Promise<TaskRecord> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.tasks.getTask(taskId, trx);
      if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
      if (current.status !== "blocked") {
        throw new InvalidTransitionError("只有 Blocked 任务可以重新排队");
      }
      const [project, binding, vm] = await Promise.all([
        trx
          .selectFrom("projects")
          .select("archived_at")
          .where("id", "=", current.projectId)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom("project_vm_bindings")
          .select("id")
          .where("project_id", "=", current.projectId)
          .where("vm_id", "=", current.vmId)
          .executeTakeFirst(),
        trx
          .selectFrom("vm_instances")
          .select("power_state")
          .where("id", "=", current.vmId)
          .executeTakeFirstOrThrow(),
      ]);
      if (project.archived_at) {
        throw new PersistenceError("conflict", "已归档项目不能重新排队任务");
      }
      if (!binding) {
        throw new PersistenceError("conflict", "目标 VM 已解绑，不能重新排队任务");
      }
      const dependenciesReady = await this.dependenciesCompleted(taskId, trx);
      const target: TaskStatus = !dependenciesReady
        ? "created"
        : vm.power_state === "running"
          ? "queued"
          : "waiting_vm";
      return this.transitionInTransaction(
        taskId,
        target,
        {
          summary: !dependenciesReady
            ? "已重新排队，等待依赖任务完成"
            : target === "queued"
              ? "已重新排队，等待 Worker 重新观察 VM"
              : "已重新排队，等待目标 VM 启动",
        },
        {
          assignedWorkerId: null,
          startedAt: null,
          completedAt: null,
          result: null,
          errorCode: null,
          errorMessage: null,
        },
        trx,
      );
    });
  }

  async setPriority(taskId: string, value: number): Promise<TaskRecord> {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PersistenceError("validation_failed", "优先级必须是有限数字");
    }
    return this.db.transaction().execute(async (trx) => {
      const current = await this.tasks.getTask(taskId, trx);
      if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
      if (
        ["running", "waiting_approval", "completed", "failed", "cancelled"].includes(current.status)
      ) {
        throw new PersistenceError("conflict", "只能调整尚未开始执行的任务优先级");
      }
      const priority = normalizeQueuePriority(value);
      if (priority === current.priority) return current;
      const now = nowIso();
      const updated = await this.tasks.updateTask(taskId, { priority, updatedAt: now }, trx);
      if (!updated) throw new NotFoundError(`任务不存在：${taskId}`);
      const payload = { taskId, from: current.priority, to: priority };
      await this.tasks.appendEvent(taskId, "task.priority_changed", payload, now, trx);
      await this.outbox.append("task.priority_changed", payload, now, trx);
      await this.appendActivity(current.projectId, "task.priority_changed", payload, now, trx);
      return updated;
    });
  }

  /** Moves dependency-ready tasks between waiting_vm and queued after VM reconciliation. */
  async reconcileVm(vmId: string): Promise<TaskRecord[]> {
    const vm = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!vm) throw new NotFoundError(`VM 不存在：${vmId}`);
    const candidates = await this.tasks.listAll({
      vmId,
      statuses: ["created", "waiting_resources", "waiting_vm", "queued"],
    });
    const updated: TaskRecord[] = [];
    for (const candidate of candidates) {
      await this.db.transaction().execute(async (trx) => {
        const current = await this.tasks.getTask(candidate.id, trx);
        if (
          !current ||
          !["created", "waiting_resources", "waiting_vm", "queued"].includes(current.status)
        ) {
          return;
        }
        if (!(await this.dependenciesCompleted(current.id, trx))) return;
        // The Resource Manager owns waiting_resources while the VM is not
        // running. Reconciling a stopped VM must not erase that decision and
        // make the queue flip between waiting_vm and waiting_resources.
        if (current.status === "waiting_resources" && vm.power_state !== "running") return;
        const target: TaskStatus = vm.power_state === "running" ? "queued" : "waiting_vm";
        if (target === current.status) return;
        updated.push(
          await this.transitionInTransaction(
            current.id,
            target,
            { summary: target === "queued" ? "依赖和 VM 已就绪" : "等待目标 VM 启动" },
            {},
            trx,
          ),
        );
      });
    }
    return updated;
  }

  /**
   * Resource Manager parks dependency-ready tasks when the host cannot
   * auto-start their VM within the soft memory budget.
   */
  async markWaitingResources(vmId: string, reason: string): Promise<TaskRecord[]> {
    const vm = await this.db
      .selectFrom("vm_instances")
      .select("id")
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!vm) throw new NotFoundError(`VM 不存在：${vmId}`);
    const summary = reason.trim() ? `等待宿主资源：${reason.trim().slice(0, 500)}` : "等待宿主资源";
    const candidates = await this.tasks.listAll({ vmId, statuses: ["waiting_vm"] });
    const updated: TaskRecord[] = [];
    for (const candidate of candidates) {
      await this.db.transaction().execute(async (trx) => {
        const current = await this.tasks.getTask(candidate.id, trx);
        if (!current || current.status !== "waiting_vm") return;
        if (!(await this.dependenciesCompleted(current.id, trx))) return;
        updated.push(
          await this.transitionInTransaction(current.id, "waiting_resources", { summary }, {}, trx),
        );
      });
    }
    return updated;
  }

  /** Atomically claims the highest-priority runnable task. Null means the VM is busy or not ready. */
  async claimNext(vmId: string, workerId?: string): Promise<TaskRecord | null> {
    await this.reconcileVm(vmId);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const vm = await trx
          .selectFrom("vm_instances")
          .select("power_state")
          .where("id", "=", vmId)
          .executeTakeFirstOrThrow();
        if (vm.power_state !== "running") return null;
        const active = await trx
          .selectFrom("tasks")
          .select("id")
          .where("vm_id", "=", vmId)
          .where("status", "in", ["running", "waiting_approval"])
          .limit(1)
          .executeTakeFirst();
        if (active) return null;

        const worker = workerId
          ? await trx
              .selectFrom("workers")
              .select(["project_id", "vm_id"])
              .where("id", "=", workerId)
              .executeTakeFirst()
          : undefined;
        if (workerId && !worker) {
          throw new PersistenceError("validation_failed", "Worker 不存在");
        }

        const candidates = (await this.tasks.listAll({ vmId, statuses: ["queued"] }, trx)).sort(
          compareQueueTasks,
        );
        for (const candidate of candidates) {
          if (!(await this.dependenciesCompleted(candidate.id, trx))) continue;
          const [project, binding] = await Promise.all([
            trx
              .selectFrom("projects")
              .select("archived_at")
              .where("id", "=", candidate.projectId)
              .executeTakeFirst(),
            trx
              .selectFrom("project_vm_bindings")
              .select("id")
              .where("project_id", "=", candidate.projectId)
              .where("vm_id", "=", candidate.vmId)
              .executeTakeFirst(),
          ]);
          if (!project || project.archived_at || !binding) continue;
          if (
            worker &&
            (worker.project_id !== candidate.projectId || worker.vm_id !== candidate.vmId)
          ) {
            // A project-scoped worker must not steal another project's queue head.
            // The matching worker can claim it; this worker may retry after that task finishes.
            return null;
          }
          return this.transitionInTransaction(
            candidate.id,
            "running",
            { summary: "Worker 已认领任务" },
            {
              attemptCount: candidate.attemptCount + 1,
              assignedWorkerId: workerId ?? candidate.assignedWorkerId,
              completedAt: null,
            },
            trx,
          );
        }
        return null;
      });
    } catch (error) {
      // Another control-plane process may have claimed the same queue head after
      // our read. The partial unique index is the final guard; losing that race
      // is an empty claim, not an internal server error or a duplicate execution.
      if (isSingleExecutionConflict(error)) return null;
      throw error;
    }
  }

  async fail(taskId: string, code: string, message: string): Promise<TaskRecord> {
    if (!code.trim() || !message.trim()) {
      throw new PersistenceError("validation_failed", "失败任务必须包含错误代码和错误信息");
    }
    return this.transition(taskId, "failed", {
      errorCode: code.trim(),
      errorMessage: message.trim(),
      summary: message.trim(),
    });
  }

  /**
   * Worker runtime uses Blocked when a turn ends or is interrupted without the
   * phase-7 completion verifier. The task keeps its evidence but releases the VM.
   */
  async block(
    taskId: string,
    code: string,
    message: string,
    summary?: string,
  ): Promise<TaskRecord> {
    if (!code.trim() || !message.trim()) {
      throw new PersistenceError("validation_failed", "阻塞任务必须包含错误代码和说明");
    }
    return this.transition(taskId, "blocked", {
      errorCode: code.trim(),
      errorMessage: message.trim(),
      summary: summary?.trim() || message.trim(),
    });
  }

  /**
   * Appends a Worker/Trace event to the task timeline. Unlike status changes it
   * does not mutate the task row; the event and Outbox notification commit
   * together so the board can observe Worker activity without polling Pi.
   */
  async recordWorkerEvent(taskId: string, type: string, payload: unknown): Promise<void> {
    if (typeof type !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(type)) {
      throw new PersistenceError("validation_failed", "Worker 事件类型无效");
    }
    const current = await this.tasks.getTask(taskId);
    if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
    const now = nowIso();
    const eventPayload = {
      taskId,
      ...(typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : { value: payload }),
    };
    await this.db.transaction().execute(async (trx) => {
      await this.tasks.appendEvent(taskId, type, eventPayload, now, trx);
      await this.outbox.append(type, eventPayload, now, trx);
      await this.appendActivity(current.projectId, type, eventPayload, now, trx);
    });
  }

  /** Server-side Worker completion API. There is intentionally no browser route for this method. */
  async complete(taskId: string, input: TaskCompletionInput): Promise<TaskRecord> {
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary || summary.length > 4000) {
      throw new PersistenceError("validation_failed", "完成结果摘要必须为 1～4000 个字符");
    }
    const current = await this.tasks.getTask(taskId);
    if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
    if (current.status !== "running") {
      throw new InvalidTransitionError("只有运行中的任务可以提交完成结果");
    }
    const verified: VerifiedArtifact[] = [];
    const seenPaths = new Set<string>();
    for (const artifact of input.artifacts ?? []) {
      const item = await this.verifyArtifactFile(artifact);
      if (seenPaths.has(item.relativePath)) {
        throw new PersistenceError("validation_failed", "完成结果包含重复产物路径");
      }
      seenPaths.add(item.relativePath);
      verified.push(item);
    }

    return this.db.transaction().execute(async (trx) => {
      const updated = await this.transitionInTransaction(
        taskId,
        "completed",
        { summary },
        { result: input.result ?? null, errorCode: null, errorMessage: null },
        trx,
      );
      if (verified.length > 0) {
        const now = nowIso();
        for (const artifact of verified) {
          await trx
            .insertInto("task_artifacts")
            .values({
              id: randomUUID(),
              project_id: updated.projectId,
              task_id: taskId,
              name: artifact.name,
              relative_path: artifact.relativePath,
              media_type: artifact.mediaType,
              size_bytes: artifact.sizeBytes,
              sha256: artifact.sha256,
              created_at: now,
              verified_at: now,
            })
            .execute();
        }
        const payload = {
          taskId,
          artifacts: verified.map((item) => ({
            relativePath: item.relativePath,
            sizeBytes: item.sizeBytes,
            sha256: item.sha256,
          })),
        };
        await this.tasks.appendEvent(taskId, "task.artifacts_verified", payload, now, trx);
        await this.outbox.append("task.artifacts_verified", payload, now, trx);
      }
      await this.reconcileDependentsInTransaction(taskId, trx);
      return (await this.tasks.getTask(taskId, trx)) ?? updated;
    });
  }

  async verifyArtifact(artifactId: string, expectedTaskId?: string): Promise<TaskArtifactRecord> {
    const row = await this.db
      .selectFrom("task_artifacts")
      .selectAll()
      .where("id", "=", artifactId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`产物不存在：${artifactId}`);
    if (expectedTaskId !== undefined && row.task_id !== expectedTaskId) {
      throw new NotFoundError("产物不属于该任务");
    }
    try {
      await this.verifyArtifactFile({
        relativePath: row.relative_path,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
      });
    } catch (error) {
      const now = nowIso();
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("task_artifacts")
          .set({ verified_at: null })
          .where("id", "=", artifactId)
          .execute();
        const payload = {
          taskId: row.task_id,
          artifactId,
          error: error instanceof Error ? error.message : "Artifact verification failed",
        };
        await this.tasks.appendEvent(
          row.task_id,
          "task.artifact_verification_failed",
          payload,
          now,
          trx,
        );
        await this.outbox.append("task.artifact_verification_failed", payload, now, trx);
      });
      throw error;
    }
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("task_artifacts")
        .set({ verified_at: now })
        .where("id", "=", artifactId)
        .execute();
      const payload = { taskId: row.task_id, artifactId, verifiedAt: now };
      await this.tasks.appendEvent(row.task_id, "task.artifact_reverified", payload, now, trx);
      await this.outbox.append("task.artifact_reverified", payload, now, trx);
    });
    const updated = await this.db
      .selectFrom("task_artifacts")
      .selectAll()
      .where("id", "=", artifactId)
      .executeTakeFirstOrThrow();
    return {
      id: updated.id,
      projectId: updated.project_id,
      taskId: updated.task_id,
      name: updated.name,
      relativePath: updated.relative_path,
      mediaType: updated.media_type,
      sizeBytes: updated.size_bytes,
      sha256: updated.sha256,
      createdAt: updated.created_at,
      verifiedAt: updated.verified_at,
    };
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.getTask(taskId);
  }

  async list(page: PageRequest, filters: TaskListFilters = {}): Promise<Page<TaskRecord>> {
    return this.tasks.listTasks(page, filters);
  }

  async board(filters: TaskListFilters = {}): Promise<TaskBoardSnapshot> {
    return this.db.transaction().execute(async (trx) => {
      const allTasks = await this.tasks.listAll({}, trx);
      const tasks = allTasks.filter(
        (task) =>
          (!filters.projectId || task.projectId === filters.projectId) &&
          (!filters.vmId || task.vmId === filters.vmId) &&
          (!filters.workerId || task.assignedWorkerId === filters.workerId) &&
          (!filters.statuses?.length || filters.statuses.includes(task.status)),
      );
      const [dependencyRows, projects, vms, workers, cursor] = await Promise.all([
        this.tasks.listDependencyIds(
          allTasks.map((task) => task.id),
          trx,
        ),
        trx.selectFrom("projects").selectAll().orderBy("created_at", "asc").execute(),
        trx.selectFrom("vm_instances").selectAll().orderBy("created_at", "asc").execute(),
        trx.selectFrom("workers").selectAll().orderBy("created_at", "asc").execute(),
        trx.selectFrom("outbox").select("id").orderBy("id", "desc").limit(1).executeTakeFirst(),
      ]);
      const statusById = new Map(allTasks.map((task) => [task.id, task.status]));
      const dependenciesByTask = new Map<string, string[]>();
      for (const row of dependencyRows) {
        const ids = dependenciesByTask.get(row.taskId) ?? [];
        ids.push(row.dependencyTaskId);
        dependenciesByTask.set(row.taskId, ids);
      }
      const queuePositions = new Map<string, number>();
      const vmIds = new Set(allTasks.map((task) => task.vmId));
      for (const vmId of vmIds) {
        const queue = allTasks
          .filter(
            (task) =>
              task.vmId === vmId &&
              task.status === "queued" &&
              (dependenciesByTask.get(task.id) ?? []).every(
                (dependencyId) => statusById.get(dependencyId) === "completed",
              ),
          )
          .sort(compareQueueTasks);
        queue.forEach((task, index) => queuePositions.set(task.id, index + 1));
      }
      const powerByVm = new Map(
        vms.map((vm) => [vm.id, vm.power_state as TaskBoardItem["vmPowerState"]]),
      );
      const osByVm = new Map(vms.map((vm) => [vm.id, vm.os_family as TaskBoardItem["vmOsFamily"]]));
      const items: TaskBoardItem[] = tasks.map((task) => ({
        ...task,
        dependencyIds: dependenciesByTask.get(task.id) ?? [],
        queuePosition: task.status === "queued" ? (queuePositions.get(task.id) ?? null) : null,
        vmPowerState: powerByVm.get(task.vmId) ?? "error",
        vmOsFamily: osByVm.get(task.vmId) ?? "linux",
      }));
      return {
        tasks: items,
        projects: projects.map(toProjectRecord),
        vms: vms.map(toVmInstanceRecord),
        workers: workers.map(toWorkerRecord),
        snapshotAt: nowIso(),
        eventCursor: cursor?.id ?? 0,
      };
    });
  }

  async detail(taskId: string): Promise<TaskDetail> {
    const [board, dependencies, events, artifacts] = await Promise.all([
      this.board(),
      this.tasks.listDependencies(taskId),
      this.tasks.listEvents(taskId),
      this.tasks.listArtifacts(taskId),
    ]);
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) throw new NotFoundError(`任务不存在：${taskId}`);
    return { task, dependencies, events, artifacts };
  }

  private async transitionInTransaction(
    taskId: string,
    to: TaskStatus,
    options: TransitionOptions,
    extraPatch: TaskUpdatePatch,
    trx: DatabaseExecutor,
  ): Promise<TaskRecord> {
    const current = await this.tasks.getTask(taskId, trx);
    if (!current) throw new NotFoundError(`任务不存在：${taskId}`);
    try {
      assertTaskTransition(current.status, to);
    } catch (error) {
      throw new InvalidTransitionError(
        error instanceof Error ? error.message : `非法任务迁移：${current.status} -> ${to}`,
      );
    }
    const now = nowIso();
    const patch: TaskUpdatePatch = { ...extraPatch, status: to, updatedAt: now };
    if (to === "running" && current.startedAt === null) patch.startedAt = now;
    if (isTerminalTaskStatus(to)) patch.completedAt = now;
    if (options.summary !== undefined) patch.latestSummary = options.summary;
    if (options.errorCode !== undefined) patch.errorCode = options.errorCode;
    if (options.errorMessage !== undefined) patch.errorMessage = options.errorMessage;
    const updated = await this.tasks.updateTask(taskId, patch, trx);
    if (!updated) throw new NotFoundError(`任务不存在：${taskId}`);
    const payload = { taskId, from: current.status, to, task: updated };
    await this.tasks.appendEvent(taskId, "task.status_changed", payload, now, trx);
    await this.outbox.append("task.status_changed", payload, now, trx);
    await this.appendActivity(
      current.projectId,
      "task.status_changed",
      { taskId, from: current.status, to },
      now,
      trx,
    );
    return updated;
  }

  private async reconcileDependentsInTransaction(
    dependencyTaskId: string,
    trx: DatabaseExecutor,
  ): Promise<void> {
    const dependents = await trx
      .selectFrom("task_dependencies")
      .innerJoin("tasks", "tasks.id", "task_dependencies.task_id")
      .selectAll("tasks")
      .where("task_dependencies.dependency_task_id", "=", dependencyTaskId)
      .where("tasks.status", "in", ["created", "waiting_resources"])
      .execute();
    for (const row of dependents) {
      if (!(await this.dependenciesCompleted(row.id, trx))) continue;
      const vm = await trx
        .selectFrom("vm_instances")
        .select("power_state")
        .where("id", "=", row.vm_id)
        .executeTakeFirstOrThrow();
      await this.transitionInTransaction(
        row.id,
        vm.power_state === "running" ? "queued" : "waiting_vm",
        {
          summary:
            vm.power_state === "running" ? "依赖已完成，进入 VM 队列" : "依赖已完成，等待 VM",
        },
        {},
        trx,
      );
    }
  }

  private async dependenciesCompleted(taskId: string, trx: DatabaseExecutor): Promise<boolean> {
    const rows = await trx
      .selectFrom("task_dependencies")
      .innerJoin("tasks", "tasks.id", "task_dependencies.dependency_task_id")
      .select("tasks.status")
      .where("task_dependencies.task_id", "=", taskId)
      .execute();
    return rows.every((row) => row.status === "completed");
  }

  private async dependenciesCompletedForIds(
    ids: readonly string[],
    trx: DatabaseExecutor,
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const rows = await trx
      .selectFrom("tasks")
      .select("status")
      .where("id", "in", [...ids])
      .execute();
    return rows.length === ids.length && rows.every((row) => row.status === "completed");
  }

  private async appendActivity(
    projectId: string,
    type: string,
    payload: unknown,
    createdAt: string,
    trx: DatabaseExecutor,
  ): Promise<void> {
    await trx
      .insertInto("project_activities")
      .values({
        project_id: projectId,
        type,
        payload_json: JSON.stringify(payload),
        created_at: createdAt,
      })
      .execute();
  }

  private async verifyArtifactFile(input: TaskArtifactInput): Promise<VerifiedArtifact> {
    if (!this.options.artifactRoot) {
      throw new PersistenceError("unavailable", "服务端未配置产物存储目录");
    }
    if (!input || typeof input.relativePath !== "string") {
      throw new PersistenceError("validation_failed", "产物路径无效");
    }
    const relativePath = input.relativePath.trim();
    const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "";
    if (
      !relativePath ||
      relativePath.length > 500 ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      relativePath.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new PersistenceError("validation_failed", "产物必须使用产物目录内的相对 POSIX 路径");
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new PersistenceError("validation_failed", "产物必须包含有效的 SHA-256");
    }
    const root = path.resolve(this.options.artifactRoot);
    const filename = path.resolve(root, ...relativePath.split("/"));
    const relative = path.relative(root, filename);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new PersistenceError("validation_failed", "产物路径越界");
    }
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
      (error: unknown) => {
        throw new PersistenceError(
          "validation_failed",
          `产物不存在、不是普通文件或无法安全打开：${relativePath}`,
          error instanceof Error ? { cause: error.message } : undefined,
        );
      },
    );
    try {
      const [rootReal, fileReal, info] = await Promise.all([
        realpath(root),
        realpath(filename),
        handle.stat(),
      ]);
      const realRelative = path.relative(rootReal, fileReal);
      if (
        !info.isFile() ||
        realRelative === ".." ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
        throw new Error("not a regular file inside artifact root");
      }
      const hash = createHash("sha256");
      let sizeBytes = 0;
      // Hash the verified descriptor, not a second pathname open. O_NOFOLLOW
      // rejects a swapped final symlink on supported hosts; the handle keeps the
      // opened file stable even if the directory entry changes during hashing.
      for await (const chunk of handle.createReadStream()) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        sizeBytes += buffer.byteLength;
      }
      if (hash.digest("hex") !== sha256) {
        throw new PersistenceError("validation_failed", `产物 SHA-256 不匹配：${relativePath}`);
      }
      if (input.sizeBytes !== undefined && input.sizeBytes !== sizeBytes) {
        throw new PersistenceError("validation_failed", `产物大小不匹配：${relativePath}`);
      }
      return {
        relativePath,
        sha256,
        sizeBytes,
        name: input.name?.trim() || path.posix.basename(relativePath),
        mediaType: input.mediaType?.trim() || "application/octet-stream",
      };
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        "validation_failed",
        `产物不存在、不是普通文件或无法读取：${relativePath}`,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

function normalizeDependencyIds(input: string[] | undefined): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 50 ||
    input.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new PersistenceError("validation_failed", "任务依赖必须是最多 50 个有效任务 ID");
  }
  return [...new Set(input.map((id) => id.trim()))].sort();
}

function isSingleExecutionConflict(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return (
    typeof value.code === "string" &&
    value.code.startsWith("SQLITE_CONSTRAINT") &&
    typeof value.message === "string" &&
    value.message.includes("tasks.vm_id")
  );
}

function compareQueueTasks(a: TaskRecord, b: TaskRecord): number {
  return (
    b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}
