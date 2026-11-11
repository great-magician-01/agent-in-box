import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type {
  WorkerArchiveRecord,
  WorkerArchiveSource,
  WorkerArchiveStatus,
  WorkerRestorePoint,
} from "@agent-in-box/protocol";
import { toWorkerArchiveRecord } from "../mappers";
import type { DatabaseSchema } from "../schema";
import { nowIso } from "../time";
import { KYSELY } from "../tokens";

export interface CreateWorkerArchiveInput {
  workerId: string;
  projectId: string;
  vmId: string;
  conversationId: string;
  archiveRef: string;
  engineType: string;
  engineVersion: string;
  sessionVersion: string;
  summary: string;
  restorePoint: WorkerRestorePoint | null;
  artifacts: WorkerArchiveRecord["artifacts"];
  source: WorkerArchiveSource;
}

export interface SearchWorkerArchivesInput {
  projectId?: string;
  query?: string;
  limit?: number;
  status?: WorkerArchiveStatus;
}

export class WorkerArchiveRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async create(input: CreateWorkerArchiveInput): Promise<WorkerArchiveRecord> {
    const now = nowIso();
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      // Only the latest archive of a Worker is eligible for native restore.
      // Older rows remain searchable as history.
      await trx
        .updateTable("worker_archives")
        .set({ status: "superseded" })
        .where("worker_id", "=", input.workerId)
        .where("status", "in", ["available", "restored"])
        .execute();
      await trx
        .insertInto("worker_archives")
        .values({
          id,
          worker_id: input.workerId,
          project_id: input.projectId,
          vm_id: input.vmId,
          conversation_id: input.conversationId,
          archive_ref: input.archiveRef,
          engine_type: input.engineType,
          engine_version: input.engineVersion,
          session_version: input.sessionVersion,
          summary: input.summary,
          restore_point_json: input.restorePoint ? JSON.stringify(input.restorePoint) : null,
          artifacts_json: JSON.stringify(input.artifacts),
          source: input.source,
          status: "available",
          created_at: now,
          restored_at: null,
        })
        .execute();
    });
    const created = await this.get(id);
    if (!created) throw new Error("Worker archive was not persisted");
    return created;
  }

  async get(id: string): Promise<WorkerArchiveRecord | undefined> {
    const row = await this.db
      .selectFrom("worker_archives")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toWorkerArchiveRecord(row) : undefined;
  }

  async latestForWorker(
    workerId: string,
    status: WorkerArchiveStatus = "available",
  ): Promise<WorkerArchiveRecord | undefined> {
    const row = await this.db
      .selectFrom("worker_archives")
      .selectAll()
      .where("worker_id", "=", workerId)
      .where("status", "=", status)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toWorkerArchiveRecord(row) : undefined;
  }

  async listForWorker(workerId: string, limit = 25): Promise<WorkerArchiveRecord[]> {
    const rows = await this.db
      .selectFrom("worker_archives")
      .selectAll()
      .where("worker_id", "=", workerId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(100, limit)))
      .execute();
    return rows.map(toWorkerArchiveRecord);
  }

  async latestAnyForWorker(workerId: string): Promise<WorkerArchiveRecord | undefined> {
    const row = await this.db
      .selectFrom("worker_archives")
      .selectAll()
      .where("worker_id", "=", workerId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toWorkerArchiveRecord(row) : undefined;
  }

  async markRestored(id: string): Promise<void> {
    await this.db
      .updateTable("worker_archives")
      .set({ status: "restored", restored_at: nowIso() })
      .where("id", "=", id)
      .execute();
  }

  async search(input: SearchWorkerArchivesInput = {}): Promise<WorkerArchiveRecord[]> {
    let query = this.db
      .selectFrom("worker_archives")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(100, input.limit ?? 25)));
    if (input.projectId) query = query.where("project_id", "=", input.projectId);
    if (input.status) query = query.where("status", "=", input.status);
    const term = input.query?.trim().toLowerCase();
    if (term) {
      query = query.where(
        sql<boolean>`(
          instr(lower(summary), ${term}) > 0
          or instr(lower(worker_id), ${term}) > 0
          or instr(lower(archive_ref), ${term}) > 0
          or instr(lower(artifacts_json), ${term}) > 0
        )`,
      );
    }
    const rows = await query.execute();
    return rows.map(toWorkerArchiveRecord);
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom("worker_archives")
      .select((builder) => builder.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
