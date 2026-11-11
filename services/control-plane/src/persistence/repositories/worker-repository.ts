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
      agentSessionRef: null,
      sessionVersion: null,
      lastHeartbeatAt: null,
      archiveSummary: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      providerId: null,
      modelId: null,
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
        agent_session_ref: null,
        session_version: null,
        last_heartbeat_at: null,
        archive_summary: null,
        last_error_code: null,
        last_error_message: null,
        broker_token_id: null,
        provider_id: null,
        model_id: null,
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

  async findReusable(
    projectId: string,
    vmId: string,
    conversationId: string,
  ): Promise<WorkerRecord | undefined> {
    const row = await this.db
      .selectFrom("workers")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("vm_id", "=", vmId)
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["starting", "running", "idle"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toWorkerRecord(row) : undefined;
  }

  async updateRuntime(
    workerId: string,
    patch: {
      status?: WorkerStatus;
      currentTaskId?: string | null;
      agentSessionRef?: string | null;
      sessionVersion?: string | null;
      lastHeartbeatAt?: string | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
      archiveSummary?: string | null;
      brokerTokenId?: string | null;
      providerId?: string | null;
      modelId?: string | null;
    },
    at: string = nowIso(),
  ): Promise<WorkerRecord | undefined> {
    await this.db
      .updateTable("workers")
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.currentTaskId !== undefined ? { current_task_id: patch.currentTaskId } : {}),
        ...(patch.agentSessionRef !== undefined
          ? { agent_session_ref: patch.agentSessionRef }
          : {}),
        ...(patch.sessionVersion !== undefined ? { session_version: patch.sessionVersion } : {}),
        ...(patch.lastHeartbeatAt !== undefined
          ? { last_heartbeat_at: patch.lastHeartbeatAt }
          : {}),
        ...(patch.lastErrorCode !== undefined ? { last_error_code: patch.lastErrorCode } : {}),
        ...(patch.lastErrorMessage !== undefined
          ? { last_error_message: patch.lastErrorMessage }
          : {}),
        ...(patch.archiveSummary !== undefined ? { archive_summary: patch.archiveSummary } : {}),
        ...(patch.brokerTokenId !== undefined ? { broker_token_id: patch.brokerTokenId } : {}),
        ...(patch.providerId !== undefined ? { provider_id: patch.providerId } : {}),
        ...(patch.modelId !== undefined ? { model_id: patch.modelId } : {}),
        last_active_at: at,
      })
      .where("id", "=", workerId)
      .execute();
    return this.getWorker(workerId);
  }

  async brokerTokenId(workerId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("workers")
      .select("broker_token_id")
      .where("id", "=", workerId)
      .executeTakeFirst();
    return row?.broker_token_id ?? null;
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
