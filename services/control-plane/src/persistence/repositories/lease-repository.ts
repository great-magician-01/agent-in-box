import type { Kysely } from "kysely";
import { Inject } from "@nestjs/common";
import type { VmLeaseRecord } from "@agent-in-box/domain";
import type { DatabaseExecutor } from "../executor";
import type { DatabaseSchema } from "../schema";
import { KYSELY } from "../tokens";

function toLeaseRecord(row: {
  id: string;
  vm_id: string;
  owner: string;
  task_id: string | null;
  acquired_at: string;
  expires_at: string;
}): VmLeaseRecord {
  if (row.owner !== "worker" && row.owner !== "human") {
    throw new Error(`Invalid lease owner in database: ${row.owner}`);
  }
  return {
    id: row.id,
    vmId: row.vm_id,
    owner: row.owner,
    taskId: row.task_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

export class LeaseRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async getByVm(
    vmId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<VmLeaseRecord | undefined> {
    const row = await executor
      .selectFrom("vm_leases")
      .selectAll()
      .where("vm_id", "=", vmId)
      .executeTakeFirst();
    return row ? toLeaseRecord(row) : undefined;
  }

  async getById(
    id: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<VmLeaseRecord | undefined> {
    const row = await executor
      .selectFrom("vm_leases")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toLeaseRecord(row) : undefined;
  }

  async insert(lease: VmLeaseRecord, executor: DatabaseExecutor = this.db): Promise<void> {
    await executor
      .insertInto("vm_leases")
      .values({
        id: lease.id,
        vm_id: lease.vmId,
        owner: lease.owner,
        task_id: lease.taskId,
        acquired_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
      })
      .execute();
  }

  async deleteById(id: string, executor: DatabaseExecutor = this.db): Promise<boolean> {
    const result = await executor.deleteFrom("vm_leases").where("id", "=", id).execute();
    return (result[0]?.numDeletedRows ?? 0n) > 0n;
  }

  async deleteByVm(vmId: string, executor: DatabaseExecutor = this.db): Promise<boolean> {
    const result = await executor.deleteFrom("vm_leases").where("vm_id", "=", vmId).execute();
    return (result[0]?.numDeletedRows ?? 0n) > 0n;
  }

  async updateExpiry(
    id: string,
    expiresAt: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .updateTable("vm_leases")
      .set({ expires_at: expiresAt })
      .where("id", "=", id)
      .execute();
  }
}
