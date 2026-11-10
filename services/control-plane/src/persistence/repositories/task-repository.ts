import type { Kysely, Updateable } from "kysely";
import type {
  Page,
  PageRequest,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
} from "@agent-in-box/protocol";
import type { DatabaseExecutor } from "../executor";
import { toTaskRecord } from "../mappers";
import type { DatabaseSchema, TasksTable } from "../schema";

export interface TaskUpdatePatch {
  status?: TaskStatus;
  priority?: number;
  assignedWorkerId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  latestSummary?: string | null;
  errorCode?: string | null;
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}\u0000${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = raw.indexOf("\u0000");
    if (separator < 0) {
      return null;
    }
    const createdAt = raw.slice(0, separator);
    const id = raw.slice(separator + 1);
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export class TaskRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async insertTask(task: TaskRecord, executor: DatabaseExecutor = this.db): Promise<void> {
    await executor
      .insertInto("tasks")
      .values({
        id: task.id,
        project_id: task.projectId,
        vm_id: task.vmId,
        origin_conversation_id: task.originConversationId,
        assigned_worker_id: task.assignedWorkerId,
        parent_task_id: task.parentTaskId,
        objective: task.objective,
        status: task.status,
        priority: task.priority,
        latest_summary: task.latestSummary,
        error_code: task.errorCode,
        created_at: task.createdAt,
        started_at: task.startedAt,
        completed_at: task.completedAt,
      })
      .execute();
  }

  async getTask(id: string, executor: DatabaseExecutor = this.db): Promise<TaskRecord | undefined> {
    const row = await executor
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toTaskRecord(row) : undefined;
  }

  async listTasks(
    page: PageRequest,
    executor: DatabaseExecutor = this.db,
  ): Promise<Page<TaskRecord>> {
    let query = executor
      .selectFrom("tasks")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(page.limit + 1);

    if (page.cursor) {
      const cursor = decodeCursor(page.cursor);
      if (cursor) {
        query = query.where((builder) =>
          builder.or([
            builder("created_at", "<", cursor.createdAt),
            builder.and([
              builder("created_at", "=", cursor.createdAt),
              builder("id", "<", cursor.id),
            ]),
          ]),
        );
      }
    }

    const rows = await query.execute();
    const items = rows.slice(0, page.limit);
    const lastItem = items.at(-1);

    return {
      items: items.map(toTaskRecord),
      nextCursor: rows.length > page.limit && lastItem ? encodeCursor(lastItem) : null,
    };
  }

  async updateTask(
    taskId: string,
    patch: TaskUpdatePatch,
    executor: DatabaseExecutor = this.db,
  ): Promise<TaskRecord | undefined> {
    const update: Updateable<TasksTable> = {};

    if (patch.status !== undefined) {
      update.status = patch.status;
    }
    if (patch.priority !== undefined) {
      update.priority = patch.priority;
    }
    if (patch.assignedWorkerId !== undefined) {
      update.assigned_worker_id = patch.assignedWorkerId;
    }
    if (patch.startedAt !== undefined) {
      update.started_at = patch.startedAt;
    }
    if (patch.completedAt !== undefined) {
      update.completed_at = patch.completedAt;
    }
    if (patch.latestSummary !== undefined) {
      update.latest_summary = patch.latestSummary;
    }
    if (patch.errorCode !== undefined) {
      update.error_code = patch.errorCode;
    }

    if (Object.keys(update).length === 0) {
      return this.getTask(taskId, executor);
    }

    await executor.updateTable("tasks").set(update).where("id", "=", taskId).execute();
    return this.getTask(taskId, executor);
  }

  async appendEvent(
    taskId: string,
    type: string,
    payload: unknown,
    createdAt: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .insertInto("task_events")
      .values({
        task_id: taskId,
        type,
        payload_json: JSON.stringify(payload),
        created_at: createdAt,
      })
      .execute();
  }

  async listEvents(
    taskId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<TaskEventRecord[]> {
    const rows = await executor
      .selectFrom("task_events")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("id", "asc")
      .execute();

    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  async findIdempotencyKey(
    key: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<{ taskId: string; requestHash: string } | undefined> {
    const row = await executor
      .selectFrom("idempotency_keys")
      .select(["task_id", "request_hash"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? { taskId: row.task_id, requestHash: row.request_hash } : undefined;
  }

  async insertIdempotencyKey(
    key: string,
    taskId: string,
    requestHash: string,
    createdAt: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .insertInto("idempotency_keys")
      .values({
        key,
        task_id: taskId,
        request_hash: requestHash,
        created_at: createdAt,
      })
      .execute();
  }

  async setAssignedWorker(
    taskId: string,
    workerId: string | null,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .updateTable("tasks")
      .set({ assigned_worker_id: workerId })
      .where("id", "=", taskId)
      .execute();
  }
}
