import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Page, PageRequest, TaskRecord, TaskStatus } from "@agent-in-box/protocol";
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
import type { DatabaseSchema } from "../schema";
import { OutboxRepository } from "../repositories/outbox-repository";
import { TaskRepository, type TaskUpdatePatch } from "../repositories/task-repository";

export interface CreateTaskInput {
  projectId: string;
  vmId: string;
  originConversationId: string;
  objective: string;
  priority?: number;
  parentTaskId?: string | null;
  idempotencyKey: string;
}

export interface CreateTaskResult {
  task: TaskRecord;
  created: boolean;
}

export interface TransitionOptions {
  summary?: string;
  errorCode?: string;
}

@Injectable()
export class TaskService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly tasks: TaskRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    const objective = input.objective.trim();
    if (!objective) {
      throw new PersistenceError("validation_failed", "Task objective must not be empty");
    }
    if (!input.idempotencyKey.trim()) {
      throw new PersistenceError("validation_failed", "Idempotency key is required");
    }

    const normalized = {
      projectId: input.projectId,
      vmId: input.vmId,
      originConversationId: input.originConversationId,
      objective,
      priority: normalizeQueuePriority(input.priority ?? 0),
      parentTaskId: input.parentTaskId ?? null,
    };
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

    return this.db.transaction().execute(async (trx) => {
      const existing = await this.tasks.findIdempotencyKey(input.idempotencyKey, trx);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        const task = await this.tasks.getTask(existing.taskId, trx);
        if (!task) {
          throw new NotFoundError(`Idempotent task no longer exists: ${existing.taskId}`);
        }
        return { task, created: false };
      }

      const now = nowIso();
      const task: TaskRecord = {
        id: randomUUID(),
        ...normalized,
        assignedWorkerId: null,
        status: "created",
        createdAt: now,
        startedAt: null,
        completedAt: null,
        latestSummary: null,
        errorCode: null,
      };

      await this.tasks.insertTask(task, trx);
      await this.tasks.insertIdempotencyKey(input.idempotencyKey, task.id, requestHash, now, trx);
      await this.tasks.appendEvent(task.id, "task.created", { task }, now, trx);
      await this.outbox.append("task.created", { task }, now, trx);

      return { task, created: true };
    });
  }

  async transition(
    taskId: string,
    to: TaskStatus,
    options: TransitionOptions = {},
  ): Promise<TaskRecord> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.tasks.getTask(taskId, trx);
      if (!current) {
        throw new NotFoundError(`Task not found: ${taskId}`);
      }

      try {
        assertTaskTransition(current.status, to);
      } catch (error) {
        throw new InvalidTransitionError(
          error instanceof Error
            ? error.message
            : `Invalid task transition: ${current.status} -> ${to}`,
        );
      }

      const now = nowIso();
      const patch: TaskUpdatePatch = { status: to };
      if (to === "running" && current.startedAt === null) {
        patch.startedAt = now;
      }
      if (isTerminalTaskStatus(to)) {
        patch.completedAt = now;
      }
      if (options.summary !== undefined) {
        patch.latestSummary = options.summary;
      }
      if (options.errorCode !== undefined) {
        patch.errorCode = options.errorCode;
      }

      const updated = await this.tasks.updateTask(taskId, patch, trx);
      if (!updated) {
        throw new NotFoundError(`Task not found after update: ${taskId}`);
      }

      await this.tasks.appendEvent(
        taskId,
        "task.status_changed",
        { taskId, from: current.status, to },
        now,
        trx,
      );
      await this.outbox.append(
        "task.status_changed",
        { taskId, from: current.status, to },
        now,
        trx,
      );

      return updated;
    });
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.getTask(taskId);
  }

  async list(page: PageRequest): Promise<Page<TaskRecord>> {
    return this.tasks.listTasks(page);
  }
}
