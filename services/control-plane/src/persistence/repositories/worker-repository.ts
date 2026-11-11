import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { WorkerRecord, WorkerStatus } from "@agent-in-box/protocol";
import { toWorkerRecord } from "../mappers";
import { nowIso } from "../time";
import type { DatabaseSchema } from "../schema";
import { KYSELY } from "../tokens";

export interface CreateWorkerInput {
  projectId: string;
  vmId: string;
  conversationId: string;
  engineType: string;
  engineVersion: string;
  capabilitySet: string[];
}

export class WorkerRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async createWorker(input: CreateWorkerInput): Promise<WorkerRecord> {
    const now = nowIso();
    const record: WorkerRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      vmId: input.vmId,
      conversationId: input.conversationId,
      engineType: input.engineType,
      engineVersion: input.engineVersion,
      status: "starting",
      currentTaskId: null,
      capabilitySet: input.capabilitySet,
      createdAt: now,
      lastActiveAt: now,
      archivedAt: null,
    };

    await this.db
      .insertInto("workers")
      .values({
        id: record.id,
        project_id: record.projectId,
        vm_id: record.vmId,
        conversation_id: record.conversationId,
        engine_type: record.engineType,
        engine_version: record.engineVersion,
        status: record.status,
        current_task_id: null,
        capability_set: JSON.stringify(record.capabilitySet),
        created_at: record.createdAt,
        last_active_at: record.lastActiveAt,
        archived_at: null,
      })
      .execute();

    return record;
  }

  async getWorker(id: string): Promise<WorkerRecord | undefined> {
    const row = await this.db
      .selectFrom("workers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toWorkerRecord(row) : undefined;
  }

  async listByProject(projectId: string, limit = 50): Promise<WorkerRecord[]> {
    const rows = await this.db
      .selectFrom("workers")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("last_active_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toWorkerRecord);
  }

  async listActive(projectId?: string, limit = 50): Promise<WorkerRecord[]> {
    let query = this.db
      .selectFrom("workers")
      .selectAll()
      .where("status", "!=", "archived")
      .orderBy("last_active_at", "desc")
      .limit(limit);

    if (projectId) {
      query = query.where("project_id", "=", projectId);
    }

    const rows = await query.execute();
    return rows.map(toWorkerRecord);
  }

  async updateStatus(
    workerId: string,
    status: WorkerStatus,
    currentTaskId: string | null,
    at: string = nowIso(),
  ): Promise<WorkerRecord | undefined> {
    await this.db
      .updateTable("workers")
      .set({
        status,
        current_task_id: currentTaskId,
        last_active_at: at,
      })
      .where("id", "=", workerId)
      .execute();
    return this.getWorker(workerId);
  }

  async archive(workerId: string, at: string = nowIso()): Promise<WorkerRecord | undefined> {
    await this.db
      .updateTable("workers")
      .set({
        status: "archived",
        current_task_id: null,
        archived_at: at,
        last_active_at: at,
      })
      .where("id", "=", workerId)
      .execute();
    return this.getWorker(workerId);
  }

  async touch(workerId: string, at: string = nowIso()): Promise<void> {
    await this.db
      .updateTable("workers")
      .set({ last_active_at: at })
      .where("id", "=", workerId)
      .execute();
  }
}
