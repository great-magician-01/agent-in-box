import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ComputerActionType,
  CuaApprovalRecord,
  CuaApprovalStatus,
} from "@agent-in-box/protocol";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { KYSELY } from "../persistence/tokens";
import { TaskService } from "../persistence/services/task-service";

export const APPROVAL_OPTIONS = Symbol("AGENT_IN_BOX_APPROVAL_OPTIONS");

export interface ApprovalOptions {
  now?: () => Date;
  pollIntervalMs?: number;
}

export interface ApprovalRequestInput {
  taskId: string;
  workerId: string;
  actionId: string;
  actionType: ComputerActionType;
  action: unknown;
  contextSummary: string;
  timeoutMs: number;
}

@Injectable()
export class ApprovalService {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tasks: TaskService,
    @Optional() @Inject(APPROVAL_OPTIONS) options: ApprovalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 150);
  }

  async request(input: ApprovalRequestInput): Promise<CuaApprovalRecord> {
    if (!input.contextSummary.trim() || input.contextSummary.length > 1000) {
      throw new PersistenceError("validation_failed", "审批上下文摘要必须为 1～1000 个字符");
    }
    const requestedAt = this.now();
    const id = randomUUID();
    const expiresAt = new Date(requestedAt.getTime() + Math.max(1000, input.timeoutMs));
    await this.db
      .insertInto("cua_approvals")
      .values({
        id,
        task_id: input.taskId,
        worker_id: input.workerId,
        action_id: input.actionId,
        action_type: input.actionType,
        action_json: JSON.stringify(input.action),
        context_summary: input.contextSummary.trim(),
        status: "pending",
        requested_at: requestedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      })
      .execute();
    await this.tasks.recordWorkerEvent(input.taskId, "task.approval_requested", {
      approvalId: id,
      actionId: input.actionId,
      actionType: input.actionType,
      expiresAt: expiresAt.toISOString(),
      summary: input.contextSummary.trim(),
    });
    return this.require(id);
  }

  async get(id: string): Promise<CuaApprovalRecord> {
    return this.require(id);
  }

  async list(
    filters: { status?: CuaApprovalStatus; taskId?: string; limit?: number } = {},
  ): Promise<CuaApprovalRecord[]> {
    let query = this.db
      .selectFrom("cua_approvals")
      .selectAll()
      .orderBy("requested_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(200, filters.limit ?? 50)));
    if (filters.status) query = query.where("status", "=", filters.status);
    if (filters.taskId) query = query.where("task_id", "=", filters.taskId);
    return (await query.execute()).map(toRecord);
  }

  async resolve(
    id: string,
    decision: "approved" | "rejected",
    resolvedBy = "local-user",
    note?: string,
  ): Promise<CuaApprovalRecord> {
    const current = await this.require(id);
    if (current.status !== "pending") {
      throw new PersistenceError("conflict", `审批已处于 ${current.status} 状态`);
    }
    return this.finish(id, decision, resolvedBy, note?.trim() || null);
  }

  /** Timeout or cancellation is resolved by the execution layer, not a human. */
  async expire(
    id: string,
    status: "timed_out" | "cancelled",
    note: string,
  ): Promise<CuaApprovalRecord> {
    return this.finish(id, status, "system", note);
  }

  async expireTimedOut(): Promise<CuaApprovalRecord[]> {
    const expired = await this.db
      .selectFrom("cua_approvals")
      .select("id")
      .where("status", "=", "pending")
      .where("expires_at", "<=", this.now().toISOString())
      .execute();
    const results: CuaApprovalRecord[] = [];
    for (const row of expired) {
      const resolved = await this.finish(row.id, "timed_out", "system", "审批等待超时");
      if (resolved) results.push(resolved);
    }
    return results;
  }

  async cancelForTask(taskId: string, reason: string): Promise<CuaApprovalRecord[]> {
    const rows = await this.db
      .selectFrom("cua_approvals")
      .select("id")
      .where("task_id", "=", taskId)
      .where("status", "=", "pending")
      .execute();
    const results: CuaApprovalRecord[] = [];
    for (const row of rows) {
      const resolved = await this.finish(row.id, "cancelled", "system", reason);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /**
   * Waits for a human decision while the tool call stays open. Polling also
   * notices task cancellation and client aborts, so an abandoned approval never
   * silently executes later.
   */
  async waitForResolution(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    isTaskStillActive?: () => Promise<boolean>,
  ): Promise<CuaApprovalRecord> {
    const deadline = this.now().getTime() + Math.max(0, timeoutMs);
    while (true) {
      if (signal?.aborted) {
        return this.finish(id, "cancelled", "system", "Computer Use 请求已断开");
      }
      const current = await this.require(id);
      if (current.status !== "pending") return current;
      if (isTaskStillActive && !(await isTaskStillActive())) {
        return this.finish(id, "cancelled", "system", "任务已离开运行状态");
      }
      if (this.now().getTime() >= deadline) {
        return this.finish(id, "timed_out", "system", "审批等待超时");
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now().getTime())));
    }
  }

  private async finish(
    id: string,
    status: Exclude<CuaApprovalStatus, "pending">,
    resolvedBy: string,
    note: string | null,
  ): Promise<CuaApprovalRecord> {
    const resolvedAt = this.now().toISOString();
    const result = await this.db
      .updateTable("cua_approvals")
      .set({
        status,
        resolved_at: resolvedAt,
        resolved_by: resolvedBy,
        resolution_note: note,
      })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    let record: CuaApprovalRecord;
    if (Number(result.numUpdatedRows ?? 0) > 0) {
      record = await this.require(id);
      await this.tasks.recordWorkerEvent(record.taskId, "task.approval_resolved", {
        approvalId: id,
        actionId: record.actionId,
        status,
        resolvedBy,
        note,
      });
      return record;
    }
    return this.require(id);
  }

  private async require(id: string): Promise<CuaApprovalRecord> {
    const row = await this.db
      .selectFrom("cua_approvals")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`审批请求不存在：${id}`);
    return toRecord(row);
  }
}

function toRecord(row: {
  id: string;
  task_id: string;
  worker_id: string;
  action_id: string;
  action_type: string;
  context_summary: string;
  status: string;
  requested_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}): CuaApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    actionId: row.action_id,
    actionType: row.action_type as ComputerActionType,
    contextSummary: row.context_summary,
    status: row.status as CuaApprovalStatus,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
