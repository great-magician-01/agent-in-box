import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ActiveRosterView,
  ActiveTaskCard,
  ActiveWorkerCard,
  ConversationMessageRecord,
  TaskRecord,
  WorkerArchiveBlockers,
  WorkerArchiveRecord,
  WorkerArchiveSearchResult,
  WorkerRecord,
  WorkerRelationSuggestion,
  WorkerRelationView,
  WorkerSummaryView,
} from "@agent-in-box/protocol";
import { toConversationRecord, toVmInstanceRecord } from "../persistence/mappers";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { TaskService } from "../persistence/services/task-service";
import { PersistenceError } from "../persistence/errors";

const ROSTER_STATUSES = new Set(["starting", "running", "idle"]);
const ACTIVE_TASK_STATUSES = new Set(["running", "waiting_approval"]);
const RECENT_TASK_LIMIT = 12;

@Injectable()
export class WorkerRegistryService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly workers: WorkerRepository,
    private readonly archives: WorkerArchiveRepository,
    private readonly tasks: TaskService,
    private readonly outbox: OutboxRepository,
  ) {}

  /** Rebuild the entire roster from persisted rows; no Router-only in-memory state. */
  async activeRoster(projectId?: string, limit = 100): Promise<ActiveRosterView> {
    const rows = (
      await this.workers.listActive(projectId, Math.max(1, Math.min(200, limit)))
    ).filter((worker) => ROSTER_STATUSES.has(worker.status));
    const cards = await this.cards(rows);
    cards.sort(compareCards);
    return { workers: cards, snapshotAt: nowIso() };
  }

  async summary(workerId: string): Promise<WorkerSummaryView> {
    const worker = await this.requireWorker(workerId);
    const roster = await this.activeRoster(worker.projectId, 200);
    const [recentTasks, recentMessages, latestArchive, blockers] = await Promise.all([
      this.tasks
        .list({ cursor: null, limit: RECENT_TASK_LIMIT }, { workerId })
        .then((page) => page.items),
      this.messages(worker, 20),
      this.archives.latestAnyForWorker(workerId),
      this.blockersFor(worker),
    ]);
    return {
      worker,
      card: roster.workers.find((card) => card.workerId === workerId) ?? null,
      recentTasks: recentTasks.map(toTaskCard),
      recentMessages,
      latestArchive: latestArchive ?? null,
      archiveBlockers: blockers,
    };
  }

  async archiveBlockers(workerId: string): Promise<WorkerArchiveBlockers> {
    return this.blockersFor(await this.requireWorker(workerId));
  }

  async workerArchives(workerId: string, limit = 25): Promise<WorkerArchiveRecord[]> {
    await this.requireWorker(workerId);
    return this.archives.listForWorker(workerId, limit);
  }

  async searchArchives(input: {
    projectId?: string;
    query?: string;
    limit?: number;
  }): Promise<WorkerArchiveSearchResult> {
    const query = input.query?.trim() ?? "";
    const projectId = input.projectId?.trim() || null;
    const items = await this.archives.search({
      ...(projectId ? { projectId } : {}),
      ...(query ? { query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return { items, query, projectId, searchedAt: nowIso() };
  }

  /**
   * Deterministic candidate filtering for the Router. Same-project membership and
   * status are hard filters; lexical similarity only orders the result.
   */
  async findRelatedWorker(input: {
    conversationId: string;
    objective: string;
    projectId?: string;
  }): Promise<WorkerRelationView> {
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective || objective.length > 4000) {
      throw new PersistenceError("validation_failed", "关联查询目标必须为 1～4000 个字符");
    }
    const conversationRow = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", input.conversationId)
      .executeTakeFirst();
    if (!conversationRow) {
      throw new PersistenceError("not_found", `会话不存在：${input.conversationId}`);
    }
    const conversation = toConversationRecord(conversationRow);
    const projectId = conversation.projectId ?? input.projectId?.trim() ?? null;
    if (!projectId) {
      throw new PersistenceError("validation_failed", "Router 会话需要指定目标项目");
    }
    const objectiveTerms = tokenize(objective);
    const candidates = await this.workers.listByProject(projectId, 200);
    const activeCandidateIds = candidates
      .filter((worker) => worker.status !== "archived")
      .map((worker) => worker.id);
    const candidateTasks =
      activeCandidateIds.length === 0
        ? []
        : await this.db
            .selectFrom("tasks")
            .selectAll()
            .where("assigned_worker_id", "in", activeCandidateIds)
            .orderBy("updated_at", "desc")
            .execute();
    const tasksByWorker = new Map<string, TaskRecord[]>();
    for (const row of candidateTasks) {
      if (!row.assigned_worker_id) continue;
      const list = tasksByWorker.get(row.assigned_worker_id) ?? [];
      list.push({
        id: row.id,
        projectId: row.project_id,
        vmId: row.vm_id,
        originConversationId: row.origin_conversation_id,
        assignedWorkerId: row.assigned_worker_id,
        parentTaskId: row.parent_task_id,
        objective: row.objective,
        status: row.status as TaskRecord["status"],
        priority: row.priority,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        latestSummary: row.latest_summary,
        result: null,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      });
      tasksByWorker.set(row.assigned_worker_id, list);
    }
    const suggestions: WorkerRelationSuggestion[] = [];
    for (const worker of candidates) {
      if (
        worker.status === "archived" ||
        worker.status === "archiving" ||
        worker.status === "restoring"
      ) {
        continue;
      }
      if (!ROSTER_STATUSES.has(worker.status) && worker.status !== "failed") continue;
      const workerTasks = tasksByWorker.get(worker.id) ?? [];
      const corpus = [
        ...workerTasks.slice(0, 5).map((task) => `${task.objective} ${task.latestSummary ?? ""}`),
        worker.archiveSummary ?? "",
      ].join("\n");
      const score =
        lexicalScore(objectiveTerms, objective, corpus) +
        (worker.conversationId === conversation.id ? 20 : 0) +
        (worker.status === "idle" ? 5 : 0);
      if (score <= 0 && worker.status !== "idle") continue;
      suggestions.push({
        workerId: worker.id,
        archiveId: null,
        projectId: worker.projectId,
        vmId: worker.vmId,
        status: worker.status,
        score,
        reasons: relationReasons(worker, score, worker.conversationId === conversation.id),
        recommendation: worker.status === "failed" ? "resume" : "reuse",
        summary: worker.archiveSummary,
      });
    }
    const archiveCandidates = await this.archives.search({ projectId, limit: 50 });
    const seenArchiveWorkers = new Set<string>();
    for (const archive of archiveCandidates) {
      if (suggestions.some((item) => item.workerId === archive.workerId)) continue;
      if (seenArchiveWorkers.has(archive.workerId)) continue;
      const score = lexicalScore(
        objectiveTerms,
        objective,
        `${archive.summary}\n${archive.artifacts.map((item) => item.name).join(" ")}`,
      );
      if (score <= 0) continue;
      seenArchiveWorkers.add(archive.workerId);
      suggestions.push({
        workerId: archive.workerId,
        archiveId: archive.id,
        projectId: archive.projectId,
        vmId: archive.vmId,
        status: "archived",
        score,
        reasons: ["archive_summary_match"],
        recommendation: "resume",
        summary: archive.summary,
      });
    }
    suggestions.sort(
      (left, right) =>
        right.score - left.score ||
        left.workerId.localeCompare(right.workerId) ||
        (left.archiveId ?? "").localeCompare(right.archiveId ?? ""),
    );
    return {
      conversationId: conversation.id,
      objective,
      projectId,
      suggestions: suggestions.slice(0, 10),
      fallback: suggestions.length > 0 ? "none" : "create_new",
      searchedAt: nowIso(),
    };
  }

  /** Persist a low-volume roster invalidation without duplicating task events. */
  async notifyChanged(workerId: string, action: string): Promise<void> {
    await this.outbox.append("registry.changed", { workerId, action }, nowIso());
  }

  private async cards(workers: WorkerRecord[]): Promise<ActiveWorkerCard[]> {
    if (workers.length === 0) return [];
    const workerIds = workers.map((worker) => worker.id);
    const vmIds = [...new Set(workers.map((worker) => worker.vmId))];
    const [projectRows, vmRows, taskRows, queueRows, approvalRows, inputRows] = await Promise.all([
      this.db
        .selectFrom("projects")
        .select(["id", "name"])
        .where("id", "in", [...new Set(workers.map((worker) => worker.projectId))])
        .execute(),
      this.db.selectFrom("vm_instances").selectAll().where("id", "in", vmIds).execute(),
      this.db
        .selectFrom("tasks")
        .selectAll()
        .where("assigned_worker_id", "in", workerIds)
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .execute(),
      this.db
        .selectFrom("tasks")
        .select(["vm_id"])
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("vm_id", "in", vmIds)
        .where("status", "=", "queued")
        .groupBy("vm_id")
        .execute(),
      this.db
        .selectFrom("cua_approvals")
        .select(["worker_id"])
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("worker_id", "in", workerIds)
        .where("status", "=", "pending")
        .groupBy("worker_id")
        .execute(),
      this.db
        .selectFrom("worker_inputs")
        .select(["worker_id"])
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("worker_id", "in", workerIds)
        .where("status", "=", "pending")
        .groupBy("worker_id")
        .execute(),
    ]);
    const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
    const vms = new Map(vmRows.map((row) => [row.id, toVmInstanceRecord(row)]));
    const queueDepth = new Map(queueRows.map((row) => [row.vm_id, Number(row.count)]));
    const pendingApprovals = new Map(approvalRows.map((row) => [row.worker_id, Number(row.count)]));
    const pendingInputs = new Map(inputRows.map((row) => [row.worker_id, Number(row.count)]));
    const latestTask = new Map<string, TaskRecord>();
    const currentTask = new Map<string, TaskRecord>();
    for (const row of taskRows) {
      const task = {
        id: row.id,
        projectId: row.project_id,
        vmId: row.vm_id,
        originConversationId: row.origin_conversation_id,
        assignedWorkerId: row.assigned_worker_id,
        parentTaskId: row.parent_task_id,
        objective: row.objective,
        status: row.status as TaskRecord["status"],
        priority: row.priority,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        latestSummary: row.latest_summary,
        result: null,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      } satisfies TaskRecord;
      if (!row.assigned_worker_id) continue;
      if (!latestTask.has(row.assigned_worker_id)) latestTask.set(row.assigned_worker_id, task);
      if (!currentTask.has(row.assigned_worker_id) && ACTIVE_TASK_STATUSES.has(task.status)) {
        currentTask.set(row.assigned_worker_id, task);
      }
    }
    return workers.map((worker) => {
      const vm = vms.get(worker.vmId);
      const current = currentTask.get(worker.id);
      const recent = latestTask.get(worker.id);
      return {
        workerId: worker.id,
        projectId: worker.projectId,
        projectName: projectNames.get(worker.projectId) ?? "",
        vmId: worker.vmId,
        vmName: vm?.name ?? "",
        vmPowerState: vm?.powerState ?? "stopped",
        conversationId: worker.conversationId,
        status: worker.status,
        engineType: worker.engineType,
        engineVersion: worker.engineVersion,
        sessionVersion: worker.sessionVersion,
        capabilities: [...worker.capabilitySet],
        currentTask: current ? toTaskCard(current) : null,
        recentTask: recent ? toTaskCard(recent) : null,
        queueDepth: queueDepth.get(worker.vmId) ?? 0,
        pendingApprovals: pendingApprovals.get(worker.id) ?? 0,
        pendingInputs: pendingInputs.get(worker.id) ?? 0,
        lastActiveAt: worker.lastActiveAt,
        lastHeartbeatAt: worker.lastHeartbeatAt,
      };
    });
  }

  private async blockersFor(worker: WorkerRecord): Promise<WorkerArchiveBlockers> {
    if (worker.status === "archived") {
      return { blocked: true, reasons: ["already_archived: Worker 已归档"] };
    }
    const [activeTasks, pendingApprovals, pendingInputs, lease] = await Promise.all([
      this.db
        .selectFrom("tasks")
        .select(["id", "status"])
        .where("assigned_worker_id", "=", worker.id)
        .where("status", "in", ["running", "waiting_approval"])
        .execute(),
      this.db
        .selectFrom("cua_approvals")
        .select("id")
        .where("worker_id", "=", worker.id)
        .where("status", "=", "pending")
        .execute(),
      this.db
        .selectFrom("worker_inputs")
        .select("id")
        .where("worker_id", "=", worker.id)
        .where("status", "=", "pending")
        .execute(),
      this.db
        .selectFrom("vm_leases")
        .select(["id", "task_id"])
        .where("vm_id", "=", worker.vmId)
        .where("owner", "=", "worker")
        .executeTakeFirst(),
    ]);
    const reasons: string[] = [];
    if (
      worker.status === "starting" ||
      worker.status === "running" ||
      worker.status === "archiving"
    ) {
      reasons.push(`worker_${worker.status}: Worker 状态为 ${worker.status}`);
    }
    if (worker.status === "restoring") {
      reasons.push("worker_restoring: Worker 正在恢复会话");
    }
    if (worker.status === "failed") {
      reasons.push("worker_failed: Worker 需要显式恢复后才能归档");
    }
    if (worker.currentTaskId) {
      reasons.push("current_task: Worker 仍记录当前任务");
    }
    if (activeTasks.length > 0) {
      reasons.push(`active_tasks: ${activeTasks.map((task) => task.id).join(",")}`);
    }
    if (pendingApprovals.length > 0) {
      reasons.push(`pending_approvals: ${pendingApprovals.length}`);
    }
    if (pendingInputs.length > 0) {
      reasons.push(`pending_inputs: ${pendingInputs.length}`);
    }
    if (lease && lease.task_id) {
      const assigned = await this.db
        .selectFrom("tasks")
        .select("assigned_worker_id")
        .where("id", "=", lease.task_id)
        .executeTakeFirst();
      if (assigned?.assigned_worker_id === worker.id) {
        reasons.push("execution_lease: Worker 持有 VM Execution Lease");
      }
    }
    return { blocked: reasons.length > 0, reasons };
  }

  private async messages(
    worker: WorkerRecord,
    limit: number,
  ): Promise<ConversationMessageRecord[]> {
    const rows = await this.db
      .selectFrom("conversation_messages")
      .selectAll()
      .where("conversation_id", "=", worker.conversationId)
      .where("worker_id", "=", worker.id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
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

  private async requireWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.workers.getWorker(workerId);
    if (!worker) throw new PersistenceError("not_found", `Worker 不存在：${workerId}`);
    return worker;
  }
}

function toTaskCard(task: TaskRecord): ActiveTaskCard {
  return {
    id: task.id,
    objective: task.objective,
    status: task.status,
    latestSummary: task.latestSummary,
    updatedAt: task.updatedAt,
  };
}

function compareCards(left: ActiveWorkerCard, right: ActiveWorkerCard): number {
  const weight = (card: ActiveWorkerCard): number =>
    card.status === "running" ? 0 : card.status === "starting" ? 1 : 2;
  return (
    weight(left) - weight(right) ||
    right.lastActiveAt.localeCompare(left.lastActiveAt) ||
    left.workerId.localeCompare(right.workerId)
  );
}

function relationReasons(worker: WorkerRecord, score: number, sameConversation: boolean): string[] {
  const reasons = [`status_${worker.status}`];
  if (sameConversation) reasons.push("same_conversation");
  if (score > 0) reasons.push("task_summary_overlap");
  if (worker.status === "idle") reasons.push("idle");
  if (worker.status === "failed" || worker.status === "archived") reasons.push("session_restore");
  return reasons;
}

function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const terms = new Set<string>();
  for (const part of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (part.length >= 2) terms.add(part);
  }
  const cjk = normalized.replace(/[^\p{Script=Han}]/gu, "");
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    terms.add(cjk.slice(index, index + 2));
  }
  return terms;
}

function lexicalScore(terms: Set<string>, objective: string, corpus: string): number {
  if (terms.size === 0) return 0;
  const normalizedCorpus = corpus.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalizedCorpus.includes(term)) score += 10;
  }
  if (normalizedCorpus.includes(objective.toLowerCase())) score += 25;
  return score;
}
