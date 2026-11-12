import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ActiveWorkerCard,
  RouterToolDefinition,
  TaskRecord,
  WorkerRecord,
} from "@agent-in-box/protocol";
import { isTaskStatus } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { KYSELY } from "../persistence/tokens";
import { TaskService } from "../persistence/services/task-service";
import { WorkerRegistryService } from "../workers/worker-registry.service";
import { WorkerRuntimeService } from "../workers/worker-runtime.service";

export interface RouterToolContext {
  conversationId: string;
  /**
   * Stable id supplied by Pi for one model tool call. It lets a retried call
   * reuse the same task while a later, identical objective gets a new task.
   * Omitted for direct/internal callers; those get a fresh key per invocation.
   */
  toolCallId?: string;
}

type RouterToolHandler = (
  args: Record<string, unknown>,
  context: RouterToolContext,
) => Promise<unknown>;

interface RouterToolSpec {
  definition: RouterToolDefinition;
  handler: RouterToolHandler;
}

const MAX_TEXT = 4000;
const MAX_COMPACT_TEXT = 500;

/**
 * The Router tool surface is deliberately narrow: projects, tasks, Workers,
 * board state and archives. There is no VM input, shell or Supervisor tool.
 */
@Injectable()
export class RouterToolService {
  private readonly tools: Map<string, RouterToolSpec>;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tasks: TaskService,
    private readonly registry: WorkerRegistryService,
    private readonly workers: WorkerRuntimeService,
  ) {
    this.tools = new Map(
      [
        this.listProjects(),
        this.listActiveWorkers(),
        this.listTasks(),
        this.getTask(),
        this.getBoardSummary(),
        this.getWorkerSummary(),
        this.findRelatedWorker(),
        this.searchWorkerArchive(),
        this.createTask(),
        this.assignTask(),
        this.steerTask(),
        this.followUpTask(),
        this.reprioritizeTask(),
        this.cancelTask(),
        this.retryTask(),
        this.resumeWorker(),
        this.archiveWorker(),
      ].map((spec) => [spec.definition.name, spec]),
    );
  }

  definitions(): RouterToolDefinition[] {
    return [...this.tools.values()]
      .map((spec) => spec.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(name: string, args: unknown, context: RouterToolContext): Promise<unknown> {
    const spec = this.tools.get(name);
    if (!spec) {
      throw new PersistenceError("not_found", `Router 工具不存在：${name}`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new PersistenceError("validation_failed", "Router 工具参数必须是 JSON 对象");
    }
    return spec.handler(args as Record<string, unknown>, context);
  }

  private listProjects(): RouterToolSpec {
    return {
      definition: {
        name: "list_projects",
        description:
          "List projects with their VM bindings and workspace paths. Use this to identify the target project before creating a task.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: async () => {
        const rows = await this.db
          .selectFrom("projects")
          .selectAll()
          .orderBy("created_at", "asc")
          .execute();
        const bindings = await this.db
          .selectFrom("project_vm_bindings")
          .innerJoin("vm_instances", "vm_instances.id", "project_vm_bindings.vm_id")
          .select([
            "project_vm_bindings.project_id as project_id",
            "project_vm_bindings.vm_id as vm_id",
            "project_vm_bindings.guest_workspace_path as guest_workspace_path",
            "project_vm_bindings.is_primary as is_primary",
            "vm_instances.name as vm_name",
            "vm_instances.os_family as os_family",
            "vm_instances.power_state as power_state",
          ])
          .orderBy("project_vm_bindings.created_at", "asc")
          .execute();
        return rows.map((row) => ({
          projectId: row.id,
          name: row.name,
          description: truncate(row.description, MAX_COMPACT_TEXT),
          archivedAt: row.archived_at,
          workspaceConfig: parseJson(row.workspace_config_json),
          bindings: bindings
            .filter((binding) => binding.project_id === row.id)
            .map((binding) => ({
              vmId: binding.vm_id,
              vmName: binding.vm_name,
              osFamily: binding.os_family,
              powerState: binding.power_state,
              guestWorkspacePath: binding.guest_workspace_path,
              isPrimary: binding.is_primary === 1,
            })),
        }));
      },
    };
  }

  private listActiveWorkers(): RouterToolSpec {
    return {
      definition: {
        name: "list_active_workers",
        description:
          "List the compact active Worker roster, optionally filtered by project. Always call this before assigning work to an existing project.",
        parameters: {
          type: "object",
          properties: { projectId: { type: "string" } },
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const projectId = optionalString(args, "projectId");
        return (await this.registry.activeRoster(projectId)).workers;
      },
    };
  }

  private listTasks(): RouterToolSpec {
    return {
      definition: {
        name: "list_tasks",
        description:
          "List recent tasks with optional project, VM, Worker and status filters. Use this to answer progress questions and find related work.",
        parameters: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            vmId: { type: "string" },
            workerId: { type: "string" },
            statuses: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "created",
                  "waiting_resources",
                  "waiting_vm",
                  "queued",
                  "running",
                  "waiting_approval",
                  "blocked",
                  "completed",
                  "failed",
                  "cancelled",
                ],
              },
            },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const limit = Math.max(1, Math.min(100, optionalNumber(args, "limit") ?? 25));
        const statuses = optionalStringArray(args, "statuses").filter(isTaskStatus);
        const page = await this.tasks.list(
          { cursor: null, limit },
          {
            ...(optionalString(args, "projectId")
              ? { projectId: optionalString(args, "projectId")! }
              : {}),
            ...(optionalString(args, "vmId") ? { vmId: optionalString(args, "vmId")! } : {}),
            ...(optionalString(args, "workerId")
              ? { workerId: optionalString(args, "workerId")! }
              : {}),
            ...(statuses.length > 0 ? { statuses } : {}),
          },
        );
        return page.items.map(compactTask);
      },
    };
  }

  private getTask(): RouterToolSpec {
    return {
      definition: {
        name: "get_task",
        description:
          "Read one task with its dependency, recent event and artifact summary. The board remains the source of truth for status.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const detail = await this.tasks.detail(requiredString(args, "taskId", MAX_COMPACT_TEXT));
        return {
          task: compactTask(detail.task),
          dependencies: detail.dependencies.map(compactTask),
          events: detail.events.slice(-25).map((event) => ({
            id: event.id,
            type: event.type,
            payload: truncate(JSON.stringify(event.payload), 1200),
            createdAt: event.createdAt,
          })),
          artifacts: detail.artifacts.map((artifact) => ({
            id: artifact.id,
            name: artifact.name,
            relativePath: artifact.relativePath,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            verifiedAt: artifact.verifiedAt,
          })),
        };
      },
    };
  }

  private getBoardSummary(): RouterToolSpec {
    return {
      definition: {
        name: "get_board_summary",
        description:
          "Summarize task counts by status, project queue depths, approvals and active Workers. Use this before reporting progress to the user.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: async () => {
        const board = await this.tasks.board();
        const byStatus: Record<string, number> = {};
        for (const task of board.tasks) {
          byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
        }
        const queueByVm = groupCounts(
          board.tasks.filter((task) => task.status === "queued").map((task) => task.vmId),
        );
        return {
          countsByStatus: byStatus,
          queueByVm,
          vms: board.vms.map((vm) => ({
            vmId: vm.id,
            name: vm.name,
            osFamily: vm.osFamily,
            powerState: vm.powerState,
            queuedTaskCount: queueByVm[vm.id] ?? 0,
          })),
          activeWorkerCount: board.workers.filter((worker) =>
            ["starting", "running", "idle"].includes(worker.status),
          ).length,
          pendingApprovalCount: await this.pendingApprovalCount(),
          taskCount: board.tasks.length,
          snapshotAt: board.snapshotAt,
        };
      },
    };
  }

  private getWorkerSummary(): RouterToolSpec {
    return {
      definition: {
        name: "get_worker_summary",
        description:
          "Read one Worker summary: current/recent tasks, recent messages, latest archive and archive blockers.",
        parameters: {
          type: "object",
          properties: { workerId: { type: "string" } },
          required: ["workerId"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const summary = await this.registry.summary(
          requiredString(args, "workerId", MAX_COMPACT_TEXT),
        );
        return {
          worker: compactWorkerRecord(summary.worker),
          card: summary.card ? compactWorker(summary.card) : null,
          recentTasks: summary.recentTasks.map((task) => ({
            id: task.id,
            status: task.status,
            objective: truncate(task.objective, MAX_COMPACT_TEXT),
            latestSummary: task.latestSummary
              ? truncate(task.latestSummary, MAX_COMPACT_TEXT)
              : null,
            updatedAt: task.updatedAt,
          })),
          recentMessages: summary.recentMessages.map((message) => ({
            id: message.id,
            role: message.role,
            mode: message.mode,
            content: truncate(message.content, 1000),
            createdAt: message.createdAt,
          })),
          latestArchive: summary.latestArchive
            ? {
                id: summary.latestArchive.id,
                status: summary.latestArchive.status,
                source: summary.latestArchive.source,
                summary: truncate(summary.latestArchive.summary, 2000),
                archiveRef: summary.latestArchive.archiveRef,
                createdAt: summary.latestArchive.createdAt,
              }
            : null,
          archiveBlockers: summary.archiveBlockers,
        };
      },
    };
  }

  private findRelatedWorker(): RouterToolSpec {
    return {
      definition: {
        name: "find_related_worker",
        description:
          "Find active or archived Workers in the same project that may already have relevant context. Suggestions only; project, VM and status filters are deterministic.",
        parameters: {
          type: "object",
          properties: {
            conversationId: { type: "string" },
            objective: { type: "string" },
            projectId: { type: "string" },
          },
          required: ["objective"],
          additionalProperties: false,
        },
      },
      handler: async (args, context) =>
        this.registry.findRelatedWorker({
          conversationId: optionalString(args, "conversationId") ?? context.conversationId,
          objective: requiredString(args, "objective", MAX_TEXT),
          ...(optionalString(args, "projectId")
            ? { projectId: optionalString(args, "projectId")! }
            : {}),
        }),
    };
  }

  private searchWorkerArchive(): RouterToolSpec {
    return {
      definition: {
        name: "search_worker_archive",
        description:
          "Search archived Worker summaries, references and artifacts. Archived Workers are not part of the active roster.",
        parameters: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      handler: async (args) =>
        this.registry.searchArchives({
          ...(optionalString(args, "projectId")
            ? { projectId: optionalString(args, "projectId")! }
            : {}),
          ...(optionalString(args, "query") ? { query: optionalString(args, "query")! } : {}),
          limit: optionalNumber(args, "limit") ?? 25,
        }),
    };
  }

  private createTask(): RouterToolSpec {
    return {
      definition: {
        name: "create_task",
        description:
          "Create a durable task for a project. If vmId is omitted, the project's primary VM is used. Prefer reusing an existing Worker after calling list_active_workers.",
        parameters: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            vmId: { type: "string" },
            objective: { type: "string" },
            priority: { type: "number" },
            dependsOn: { type: "array", items: { type: "string" } },
            parentTaskId: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["projectId", "objective"],
          additionalProperties: false,
        },
      },
      handler: async (args, context) => {
        const projectId = requiredString(args, "projectId", MAX_COMPACT_TEXT);
        const objective = requiredString(args, "objective", MAX_TEXT);
        const vmId = optionalString(args, "vmId") ?? (await this.primaryVmId(projectId));
        const dependsOn = optionalStringArray(args, "dependsOn");
        const parentTaskId = optionalString(args, "parentTaskId");
        const priority = optionalNumber(args, "priority") ?? 0;
        const idempotencyKey =
          optionalString(args, "idempotencyKey") ??
          `router:${context.conversationId}:${sha256(
            JSON.stringify({
              call: context.toolCallId ?? randomUUID(),
              projectId,
              vmId,
              objective,
              priority,
              dependsOn,
              parentTaskId,
            }),
          )}`;
        const result = await this.tasks.create({
          projectId,
          vmId,
          originConversationId: context.conversationId,
          objective,
          priority,
          ...(parentTaskId ? { parentTaskId } : {}),
          dependsOn,
          idempotencyKey,
        });
        const roster = await this.registry.activeRoster(projectId);
        return {
          created: result.created,
          task: compactTask(result.task),
          availableWorkers: roster.workers.map(compactWorker),
        };
      },
    };
  }

  private assignTask(): RouterToolSpec {
    return {
      definition: {
        name: "assign_task",
        description:
          "Create a task explicitly scoped to an existing Worker's project and VM. The Worker claims it when idle; this never bypasses the VM queue.",
        parameters: {
          type: "object",
          properties: {
            workerId: { type: "string" },
            objective: { type: "string" },
            priority: { type: "number" },
            dependsOn: { type: "array", items: { type: "string" } },
          },
          required: ["workerId", "objective"],
          additionalProperties: false,
        },
      },
      handler: async (args, context) => {
        const worker = await this.requireWorker(requiredString(args, "workerId", MAX_COMPACT_TEXT));
        const objective = requiredString(args, "objective", MAX_TEXT);
        const dependsOn = optionalStringArray(args, "dependsOn");
        const priority = optionalNumber(args, "priority") ?? 0;
        const result = await this.tasks.create({
          projectId: worker.projectId,
          vmId: worker.vmId,
          originConversationId: context.conversationId,
          objective,
          priority,
          dependsOn,
          idempotencyKey: `router:${context.conversationId}:assign:${sha256(
            JSON.stringify({
              call: context.toolCallId ?? randomUUID(),
              workerId: worker.id,
              objective,
              priority,
              dependsOn,
            }),
          )}`,
        });
        return {
          created: result.created,
          task: compactTask(result.task),
          worker: compactWorkerRecord(worker),
        };
      },
    };
  }

  private steerTask(): RouterToolSpec {
    return {
      definition: {
        name: "steer_task",
        description:
          "Insert a steering instruction into the currently running Worker turn for a task.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" }, text: { type: "string" } },
          required: ["taskId", "text"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const task = await this.requireAssignedTask(
          requiredString(args, "taskId", MAX_COMPACT_TEXT),
          true,
        );
        const result = await this.workers.steer(task.assignedWorkerId!, {
          text: requiredString(args, "text", MAX_TEXT),
        });
        return { ...result, taskId: task.id, workerId: task.assignedWorkerId };
      },
    };
  }

  private followUpTask(): RouterToolSpec {
    return {
      definition: {
        name: "follow_up_task",
        description:
          "Queue a follow-up instruction for the Worker's next turn after the current task settles.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" }, text: { type: "string" } },
          required: ["taskId", "text"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const task = await this.requireAssignedTask(
          requiredString(args, "taskId", MAX_COMPACT_TEXT),
          false,
        );
        const result = await this.workers.followUp(task.assignedWorkerId!, {
          text: requiredString(args, "text", MAX_TEXT),
        });
        return { ...result, taskId: task.id, workerId: task.assignedWorkerId };
      },
    };
  }

  private reprioritizeTask(): RouterToolSpec {
    return {
      definition: {
        name: "reprioritize_task",
        description: "Change the queue priority of a task that has not started yet.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" }, priority: { type: "number" } },
          required: ["taskId", "priority"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const priority = requiredNumber(args, "priority");
        return compactTask(
          await this.tasks.setPriority(requiredString(args, "taskId", MAX_COMPACT_TEXT), priority),
        );
      },
    };
  }

  private cancelTask(): RouterToolSpec {
    return {
      definition: {
        name: "cancel_task",
        description: "Cancel a non-terminal task. Running desktop actions are aborted by the host.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" }, reason: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
      handler: async (args) =>
        compactTask(
          await this.tasks.cancel(
            requiredString(args, "taskId", MAX_COMPACT_TEXT),
            optionalString(args, "reason") ?? "Router 取消任务",
          ),
        ),
    };
  }

  private retryTask(): RouterToolSpec {
    return {
      definition: {
        name: "retry_task",
        description: "Retry a failed task after its blocker has been resolved.",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
      handler: async (args) =>
        compactTask(await this.tasks.retry(requiredString(args, "taskId", MAX_COMPACT_TEXT))),
    };
  }

  private resumeWorker(): RouterToolSpec {
    return {
      definition: {
        name: "resume_worker",
        description:
          "Resume an archived or failed Worker. Auto mode uses a compatible native session first, then explicitly falls back to an archive summary.",
        parameters: {
          type: "object",
          properties: {
            workerId: { type: "string" },
            mode: { type: "string", enum: ["auto", "native", "summary"] },
          },
          required: ["workerId"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const mode = optionalString(args, "mode") ?? "auto";
        if (mode !== "auto" && mode !== "native" && mode !== "summary") {
          throw new PersistenceError("validation_failed", "恢复模式必须是 auto、native 或 summary");
        }
        const result = await this.workers.resume(
          requiredString(args, "workerId", MAX_COMPACT_TEXT),
          { mode },
        );
        return {
          worker: compactWorkerRecord(result.worker.worker),
          restoreMode: result.restoreMode,
          notice: result.notice,
          contextId: result.context.id,
        };
      },
    };
  }

  private archiveWorker(): RouterToolSpec {
    return {
      definition: {
        name: "archive_worker",
        description:
          "Archive an idle, connected Worker. The host rejects this while the Worker has a running task, approval, queued message or execution lease.",
        parameters: {
          type: "object",
          properties: { workerId: { type: "string" } },
          required: ["workerId"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const worker = await this.workers.archive(
          requiredString(args, "workerId", MAX_COMPACT_TEXT),
        );
        return compactWorkerRecord(worker.worker);
      },
    };
  }

  private async primaryVmId(projectId: string): Promise<string> {
    const binding = await this.db
      .selectFrom("project_vm_bindings")
      .select(["vm_id"])
      .where("project_id", "=", projectId)
      .orderBy("is_primary", "desc")
      .orderBy("created_at", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!binding) {
      throw new PersistenceError("validation_failed", "项目没有可用的 VM 绑定");
    }
    return binding.vm_id;
  }

  private async requireWorker(workerId: string): Promise<WorkerRecord> {
    const row = await this.db
      .selectFrom("workers")
      .selectAll()
      .where("id", "=", workerId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", `Worker 不存在：${workerId}`);
    if (row.status === "archived") {
      throw new PersistenceError(
        "conflict",
        "已归档 Worker 不能直接分配任务，请先恢复或新建 Worker",
      );
    }
    return {
      id: row.id,
      projectId: row.project_id,
      vmId: row.vm_id,
      conversationId: row.conversation_id,
      engineType: row.engine_type,
      engineVersion: row.engine_version,
      status: row.status as WorkerRecord["status"],
      currentTaskId: row.current_task_id,
      capabilitySet: parseJsonArray(row.capability_set),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      archivedAt: row.archived_at,
      agentSessionRef: row.agent_session_ref,
      sessionVersion: row.session_version,
      lastHeartbeatAt: row.last_heartbeat_at,
      archiveSummary: row.archive_summary,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      providerId: row.provider_id,
      modelId: row.model_id,
    };
  }

  private async requireAssignedTask(taskId: string, running: boolean): Promise<TaskRecord> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new PersistenceError("not_found", `任务不存在：${taskId}`);
    if (!task.assignedWorkerId) {
      throw new PersistenceError("conflict", "任务尚未被 Worker 认领");
    }
    if (running && task.status !== "running") {
      throw new PersistenceError("conflict", "只有运行中的任务可以 Steer");
    }
    if (!running && !["running", "waiting_approval", "blocked", "queued"].includes(task.status)) {
      throw new PersistenceError("conflict", `任务状态 ${task.status} 不能 Follow-up`);
    }
    return task;
  }

  private async pendingApprovalCount(): Promise<number> {
    const row = await this.db
      .selectFrom("cua_approvals")
      .select((builder) => builder.fn.countAll<number>().as("count"))
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}

function compactTask(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    projectId: task.projectId,
    vmId: task.vmId,
    assignedWorkerId: task.assignedWorkerId,
    status: task.status,
    priority: task.priority,
    objective: truncate(task.objective, MAX_COMPACT_TEXT),
    latestSummary: task.latestSummary ? truncate(task.latestSummary, MAX_COMPACT_TEXT) : null,
    errorCode: task.errorCode,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  };
}

function compactWorker(card: ActiveWorkerCard): Record<string, unknown> {
  return {
    workerId: card.workerId,
    projectId: card.projectId,
    vmId: card.vmId,
    status: card.status,
    capabilities: card.capabilities,
    currentTaskId: card.currentTask?.id ?? null,
    recentTaskStatus: card.recentTask?.status ?? null,
    queueDepth: card.queueDepth,
    pendingApprovals: card.pendingApprovals,
    pendingInputs: card.pendingInputs,
    lastActiveAt: card.lastActiveAt,
  };
}

function compactWorkerRecord(worker: WorkerRecord): Record<string, unknown> {
  return {
    workerId: worker.id,
    projectId: worker.projectId,
    vmId: worker.vmId,
    status: worker.status,
    capabilities: worker.capabilitySet,
  };
}

function requiredString(args: Record<string, unknown>, field: string, maxLength: number): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new PersistenceError(
      "validation_failed",
      `${field} 必须是 1～${maxLength} 个字符的字符串`,
    );
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new PersistenceError("validation_failed", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PersistenceError("validation_failed", `${field} 必须是有限数字`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, field: string): number {
  const value = optionalNumber(args, field);
  if (value === undefined) {
    throw new PersistenceError("validation_failed", `${field} 必须是有限数字`);
  }
  return value;
}

function optionalStringArray(args: Record<string, unknown>, field: string): string[] {
  const value = args[field];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)
  ) {
    throw new PersistenceError("validation_failed", `${field} 必须是最多 50 个有效字符串`);
  }
  return value.map((item) => item.trim());
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function groupCounts(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
