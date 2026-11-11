import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  ACTIVE_TASK_STATUSES,
  type CreateVmSnapshotRequest,
  type RestoreVmSnapshotRequest,
  type VmPowerState,
  type VmProjectReference,
  type VmSnapshotImpact,
  type VmSnapshotProjectImpact,
  type VmSnapshotRecord,
} from "@agent-in-box/protocol";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { SupervisorClient } from "./supervisor.client";

@Injectable()
export class SnapshotService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly supervisor: SupervisorClient,
    private readonly outbox: OutboxRepository,
  ) {}

  async list(vmId: string): Promise<VmSnapshotRecord[]> {
    await this.requireVm(vmId);
    const rows = await this.db
      .selectFrom("vm_snapshots")
      .selectAll()
      .where("vm_id", "=", vmId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(toSnapshotRecord);
  }

  async create(vmId: string, input: CreateVmSnapshotRequest = {}): Promise<VmSnapshotRecord> {
    const vm = await this.requireVm(vmId);
    const runtime = await this.supervisor.get(vmId);
    if (runtime.powerState !== "stopped") {
      throw new PersistenceError("conflict", "创建整机快照前必须停止 VM（当前必须为 stopped）");
    }
    await this.assertNoActiveExecution(vmId);
    const label = normalizeLabel(input.label);
    const affectedProjects = await this.currentProjects(vmId);
    const id = randomUUID();
    const tag = `aib-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const now = nowIso();
    await this.db
      .insertInto("vm_snapshots")
      .values({
        id,
        vm_id: vmId,
        tag,
        label,
        status: "creating",
        affected_projects_json: JSON.stringify(affectedProjects),
        size_bytes: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        restored_at: null,
      })
      .execute();
    try {
      await this.supervisor.createSnapshot(vmId, tag);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .updateTable("vm_snapshots")
        .set({ status: "failed", error_message: message, updated_at: nowIso() })
        .where("id", "=", id)
        .execute();
      throw new PersistenceError("unavailable", `创建整机快照失败：${message}`);
    }
    await this.db
      .updateTable("vm_snapshots")
      .set({ status: "available", updated_at: nowIso() })
      .where("id", "=", id)
      .execute();
    const payload = {
      vmId,
      vmName: vm.name,
      snapshotId: id,
      tag,
      label,
      affectedProjects,
    };
    await this.outbox.append("vm.snapshot_created", payload, nowIso());
    return this.get(vmId, id);
  }

  async impact(vmId: string, snapshotId: string): Promise<VmSnapshotImpact> {
    const vm = await this.requireVm(vmId);
    const snapshot = await this.get(vmId, snapshotId);
    const runtime = await this.supervisor.get(vmId).catch(() => null);
    return this.buildImpact(vm, snapshot, runtime?.powerState ?? (vm.power_state as VmPowerState));
  }

  async restore(
    vmId: string,
    snapshotId: string,
    input: RestoreVmSnapshotRequest = {},
  ): Promise<VmSnapshotImpact> {
    const vm = await this.requireVm(vmId);
    const snapshot = await this.get(vmId, snapshotId);
    if (snapshot.status !== "available") {
      throw new PersistenceError("conflict", "只有 available 状态的快照可以恢复");
    }
    const runtime = await this.supervisor.get(vmId);
    const impact = await this.buildImpact(vm, snapshot, runtime.powerState);
    if (runtime.powerState !== "stopped") {
      throw new PersistenceError("conflict", "恢复整机快照前必须停止 VM");
    }
    if (impact.blocked) {
      throw new PersistenceError(
        "conflict",
        impact.conflicts[0]?.message ?? "当前有活动任务，不能恢复整机快照",
        { impact },
      );
    }
    if (impact.requiresConfirmation && input.confirmSharedImpact !== true) {
      throw new PersistenceError(
        "conflict",
        `恢复整机快照会影响 ${impact.affectedProjects.length} 个项目，请先确认受影响项目`,
        { impact },
      );
    }
    try {
      await this.supervisor.restoreSnapshot(vmId, snapshot.tag);
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `恢复整机快照失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const now = nowIso();
    await this.db
      .updateTable("vm_snapshots")
      .set({ updated_at: now, restored_at: now })
      .where("id", "=", snapshotId)
      .execute();
    await this.outbox.append(
      "vm.snapshot_restored",
      {
        vmId,
        vmName: vm.name,
        snapshotId,
        tag: snapshot.tag,
        affectedProjects: impact.affectedProjects,
      },
      now,
    );
    return this.buildImpact(vm, await this.get(vmId, snapshotId), "stopped");
  }

  private async buildImpact(
    vm: { id: string; name: string; power_state: string },
    snapshot: VmSnapshotRecord,
    powerState: VmPowerState,
  ): Promise<VmSnapshotImpact> {
    const [projects, taskRows, leases] = await Promise.all([
      this.currentProjects(vm.id),
      this.db
        .selectFrom("tasks")
        .select(["project_id", "status", "updated_at", "id"])
        .where("vm_id", "=", vm.id)
        .execute(),
      this.db.selectFrom("vm_leases").select(["expires_at"]).where("vm_id", "=", vm.id).execute(),
    ]);
    const activeStatuses = new Set<string>(ACTIVE_TASK_STATUSES);
    const affectedProjects: VmSnapshotProjectImpact[] = projects.map((project) => {
      const rows = taskRows.filter((task) => task.project_id === project.id);
      return {
        ...project,
        activeTaskCount: rows.filter((task) => activeStatuses.has(task.status)).length,
        lastActivityAt:
          rows.map((task) => task.updated_at).sort((a, b) => b.localeCompare(a))[0] ?? null,
      };
    });
    const activeTaskCount = taskRows.filter((task) => activeStatuses.has(task.status)).length;
    const hasLease = leases.some((lease) => Date.parse(lease.expires_at) > Date.now());
    const previousIds = new Set(snapshot.affectedProjects.map((project) => project.id));
    const currentIds = new Set(projects.map((project) => project.id));
    const bindingSetChanged =
      previousIds.size !== currentIds.size || [...currentIds].some((id) => !previousIds.has(id));
    const conflicts: VmSnapshotImpact["conflicts"] = [];
    if (powerState !== "stopped") {
      conflicts.push({
        reason: "vm_not_stopped",
        message: "VM 不是 stopped 状态，无法恢复整机快照",
      });
    }
    if (activeTaskCount > 0) {
      conflicts.push({ reason: "active_tasks", message: "VM 上仍有活动任务，不能恢复整机快照" });
    }
    if (hasLease) {
      conflicts.push({
        reason: "execution_lease",
        message: "VM 仍有 Execution Lease，不能恢复整机快照",
      });
    }
    const projectList =
      affectedProjects.length > 0
        ? affectedProjects.map((project) => project.name).join("、")
        : "（当前未绑定项目）";
    const warning =
      affectedProjects.length > 1
        ? `这是共享 VM 的整机快照恢复：桌面、软件、文件和系统状态会回滚到快照时间点，影响全部 ${affectedProjects.length} 个项目（${projectList}）。不能只回滚其中一个项目。`
        : `恢复整机快照会把桌面、软件、文件和系统状态回滚到快照时间点；当前绑定项目：${projectList}。`;
    return {
      snapshot,
      vmId: vm.id,
      vmName: vm.name,
      vmPowerState: powerState,
      affectedProjects,
      bindingSetChanged,
      activeTaskCount,
      requiresConfirmation: affectedProjects.length > 1 || bindingSetChanged,
      warning,
      blocked: conflicts.length > 0,
      conflicts,
    };
  }

  private async assertNoActiveExecution(vmId: string): Promise<void> {
    const [task, lease] = await Promise.all([
      this.db
        .selectFrom("tasks")
        .select("id")
        .where("vm_id", "=", vmId)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .limit(1)
        .executeTakeFirst(),
      this.db.selectFrom("vm_leases").select(["expires_at"]).where("vm_id", "=", vmId).execute(),
    ]);
    if (task) throw new PersistenceError("conflict", "VM 上仍有活动任务，不能创建整机快照");
    if (lease.some((row) => Date.parse(row.expires_at) > Date.now())) {
      throw new PersistenceError("conflict", "VM 仍有 Execution Lease，不能创建整机快照");
    }
  }

  private async currentProjects(vmId: string): Promise<VmProjectReference[]> {
    const rows = await this.db
      .selectFrom("project_vm_bindings")
      .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
      .select([
        "projects.id as id",
        "projects.name as name",
        "projects.archived_at as archived_at",
        "project_vm_bindings.is_primary as is_primary",
      ])
      .where("project_vm_bindings.vm_id", "=", vmId)
      .orderBy("projects.created_at", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isPrimary: row.is_primary === 1,
      archivedAt: row.archived_at,
    }));
  }

  private async requireVm(
    vmId: string,
  ): Promise<{ id: string; name: string; power_state: string }> {
    const row = await this.db
      .selectFrom("vm_instances")
      .select(["id", "name", "power_state"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`VM 不存在：${vmId}`);
    return row;
  }

  private async get(vmId: string, snapshotId: string): Promise<VmSnapshotRecord> {
    const row = await this.db
      .selectFrom("vm_snapshots")
      .selectAll()
      .where("id", "=", snapshotId)
      .where("vm_id", "=", vmId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`快照不存在：${snapshotId}`);
    return toSnapshotRecord(row);
  }
}

function toSnapshotRecord(row: {
  id: string;
  vm_id: string;
  tag: string;
  label: string;
  status: string;
  affected_projects_json: string;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  restored_at: string | null;
}): VmSnapshotRecord {
  return {
    id: row.id,
    vmId: row.vm_id,
    tag: row.tag,
    label: row.label,
    status: row.status as VmSnapshotRecord["status"],
    affectedProjects: parseProjects(row.affected_projects_json),
    sizeBytes: row.size_bytes,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    restoredAt: row.restored_at,
  };
}

function parseProjects(value: string): VmProjectReference[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is VmProjectReference =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as VmProjectReference).id === "string" &&
        typeof (item as VmProjectReference).name === "string",
    );
  } catch {
    return [];
  }
}

function normalizeLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length > 80) {
    throw new PersistenceError("validation_failed", "快照标签不能超过 80 个字符");
  }
  return label || `整机快照 ${new Date().toLocaleString("zh-CN")}`;
}
