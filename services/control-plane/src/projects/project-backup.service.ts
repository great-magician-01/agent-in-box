import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  ACTIVE_TASK_STATUSES,
  type CreateProjectBackupRequest,
  type ProjectBackupArtifactRef,
  type ProjectBackupBindingRecord,
  type ProjectBackupConflict,
  type ProjectBackupImpact,
  type ProjectBackupRecord,
  type ProjectBackupVerifyResult,
  type RestoreProjectBackupRequest,
  type VmProjectReference,
} from "@agent-in-box/protocol";
import { guestPathEqualsOrWithin, guestPathsEqual } from "@agent-in-box/domain";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import { DatabaseService } from "../persistence/database.service";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { LeaseService } from "../persistence/services/lease-service";
import { GuestClient } from "../vms/guest.client";
import { SupervisorClient } from "../vms/supervisor.client";

const BACKUP_ROOT = "project-backups";
const BACKUP_LEASE_TTL_MS = 15 * 60_000;

interface BindingRow {
  id: string;
  project_id: string;
  vm_id: string;
  guest_workspace_path: string;
}

interface BackupBindingRow {
  id: string;
  backup_id: string;
  binding_id: string;
  vm_id: string;
  vm_name: string;
  guest_workspace_path: string;
  file_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  file_count: number | null;
  status: string;
  error_message: string | null;
}

interface BackupRow {
  id: string;
  project_id: string;
  label: string;
  status: string;
  artifact_snapshot_json: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  restored_at: string | null;
}

@Injectable()
export class ProjectBackupService implements OnModuleInit {
  private readonly logger = new Logger(ProjectBackupService.name);

  async onModuleInit(): Promise<void> {
    // A process crash leaves these statuses without a running operation. Mark
    // them failed so restore/delete are not blocked forever.
    await this.db
      .updateTable("project_backups")
      .set({ status: "failed", error_message: "控制平面重启中断了备份操作" })
      .where("status", "in", ["creating", "restoring"])
      .execute()
      .catch((error: unknown) => {
        this.logger.warn(`Failed to reconcile interrupted project backups: ${String(error)}`);
      });
  }

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly database: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly leases: LeaseService,
    private readonly guest: GuestClient,
    private readonly supervisor: SupervisorClient,
  ) {}

  async list(projectId: string): Promise<ProjectBackupRecord[]> {
    await this.requireProject(projectId);
    const [backups, bindings] = await Promise.all([
      this.db
        .selectFrom("project_backups")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at", "desc")
        .execute(),
      this.db
        .selectFrom("project_backup_bindings")
        .innerJoin("project_backups", "project_backups.id", "project_backup_bindings.backup_id")
        .selectAll("project_backup_bindings")
        .where("project_backups.project_id", "=", projectId)
        .execute(),
    ]);
    const byBackup = groupBindings(bindings);
    return backups.map((backup) => toRecord(backup, byBackup.get(backup.id) ?? []));
  }

  async create(
    projectId: string,
    input: CreateProjectBackupRequest = {},
  ): Promise<ProjectBackupRecord> {
    await this.requireProject(projectId);
    const label = normalizeLabel(input.label);
    const bindings = await this.requireBindings(projectId);
    if (bindings.length === 0) {
      throw new PersistenceError("conflict", "项目没有绑定 VM，无法备份工作目录");
    }
    const vmRows = await this.loadVms(bindings.map((binding) => binding.vm_id));
    const artifacts = await this.projectArtifacts(projectId);
    const backupId = randomUUID();
    const now = nowIso();
    const bindingRows: BackupBindingRow[] = [];
    for (const binding of bindings) {
      const vm = vmRows.get(binding.vm_id);
      if (!vm) throw new NotFoundError(`VM 不存在：${binding.vm_id}`);
      const runtime = await this.supervisor.get(binding.vm_id);
      if (runtime.powerState !== "running") {
        throw new PersistenceError(
          "conflict",
          `VM「${vm.name}」未运行，项目目录备份需要启动 VM 后再执行`,
        );
      }
      await this.assertBindingFree(binding);
      const filePath = path.posix.join(BACKUP_ROOT, projectId, backupId, `${binding.id}.tar.gz`);
      bindingRows.push({
        id: randomUUID(),
        backup_id: backupId,
        binding_id: binding.id,
        vm_id: binding.vm_id,
        vm_name: vm.name,
        guest_workspace_path: binding.guest_workspace_path,
        file_path: filePath,
        sha256: null,
        size_bytes: null,
        file_count: null,
        status: "pending",
        error_message: null,
      });
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("project_backups")
        .values({
          id: backupId,
          project_id: projectId,
          label,
          status: "creating",
          artifact_snapshot_json: JSON.stringify(artifacts),
          error_message: null,
          created_at: now,
          completed_at: null,
          restored_at: null,
        })
        .execute();
      for (const row of bindingRows) {
        await trx
          .insertInto("project_backup_bindings")
          .values({
            id: row.id,
            backup_id: row.backup_id,
            binding_id: row.binding_id,
            vm_id: row.vm_id,
            vm_name: row.vm_name,
            guest_workspace_path: row.guest_workspace_path,
            file_path: row.file_path,
            sha256: row.sha256,
            size_bytes: row.size_bytes,
            file_count: row.file_count,
            status: row.status,
            error_message: row.error_message,
          })
          .execute();
      }
    });

    const backupDirectory = this.backupDirectory(projectId, backupId);
    try {
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      for (let index = 0; index < bindingRows.length; index += 1) {
        const row = bindingRows[index]!;
        const binding = bindings[index]!;
        const vm = vmRows.get(binding.vm_id)!;
        const runtime = await this.supervisor.get(binding.vm_id);
        if (!runtime.guestHostPort) {
          throw new PersistenceError("unavailable", `VM「${vm.name}」没有 Guest Agent 回环端口`);
        }
        const lease = await this.leases.acquire({
          vmId: binding.vm_id,
          owner: "human",
          taskId: null,
          ttlMs: BACKUP_LEASE_TTL_MS,
        });
        try {
          const destination = this.resolveBackupFile(row.file_path!);
          const result = await this.guest.downloadWorkspace(
            { hostPort: runtime.guestHostPort, storageRoot: vm.storage_root },
            binding.guest_workspace_path,
            destination,
          );
          await this.db
            .updateTable("project_backup_bindings")
            .set({
              status: "available",
              sha256: result.sha256,
              size_bytes: result.sizeBytes,
              file_count: result.fileCount,
              error_message: null,
            })
            .where("id", "=", row.id)
            .execute();
        } finally {
          await this.leases.release(binding.vm_id, lease.id).catch(() => undefined);
        }
      }
      await this.db
        .updateTable("project_backups")
        .set({ status: "available", completed_at: nowIso() })
        .where("id", "=", backupId)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Project backup ${backupId} failed: ${message}`);
      await this.db
        .updateTable("project_backup_bindings")
        .set({ status: "failed", error_message: message })
        .where("backup_id", "=", backupId)
        .where("status", "=", "pending")
        .execute();
      await this.db
        .updateTable("project_backups")
        .set({ status: "failed", error_message: message, completed_at: nowIso() })
        .where("id", "=", backupId)
        .execute();
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("unavailable", `项目目录备份失败：${message}`);
    }
    await this.outbox.append(
      "project.backup_created",
      { projectId, backupId, label, bindingCount: bindingRows.length },
      nowIso(),
    );
    return this.get(projectId, backupId);
  }

  async get(projectId: string, backupId: string): Promise<ProjectBackupRecord> {
    const backup = await this.requireBackup(projectId, backupId);
    const bindings = await this.db
      .selectFrom("project_backup_bindings")
      .selectAll()
      .where("backup_id", "=", backupId)
      .execute();
    return toRecord(backup, bindings);
  }

  async impact(projectId: string, backupId: string): Promise<ProjectBackupImpact> {
    const backup = await this.requireBackup(projectId, backupId);
    const bindings = await this.db
      .selectFrom("project_backup_bindings")
      .selectAll()
      .where("backup_id", "=", backupId)
      .execute();
    if (bindings.length === 0) {
      throw new PersistenceError("conflict", "备份不包含任何工作目录");
    }
    const conflicts: ProjectBackupConflict[] = [];
    for (const binding of bindings) {
      const current = await this.db
        .selectFrom("project_vm_bindings")
        .selectAll()
        .where("id", "=", binding.binding_id)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!current) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "binding_missing",
          message: `VM「${binding.vm_name}」的项目绑定已被删除，无法恢复该目录`,
          affectedProjects: [],
        });
        continue;
      }
      if (!guestPathsEqual(current.guest_workspace_path, binding.guest_workspace_path)) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "workspace_path_changed",
          message: `VM「${binding.vm_name}」的项目目录已从 ${binding.guest_workspace_path} 改为 ${current.guest_workspace_path}；备份不会写入新目录`,
          affectedProjects: [],
        });
      }
      const bindings = await this.db
        .selectFrom("project_vm_bindings")
        .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
        .select([
          "projects.id as id",
          "projects.name as name",
          "projects.archived_at as archived_at",
          "project_vm_bindings.is_primary as is_primary",
          "project_vm_bindings.guest_workspace_path as guest_workspace_path",
        ])
        .where("project_vm_bindings.vm_id", "=", binding.vm_id)
        .where("project_vm_bindings.project_id", "!=", projectId)
        .execute();
      const shared = bindings.filter(
        (candidate) =>
          guestPathEqualsOrWithin(candidate.guest_workspace_path, binding.guest_workspace_path) ||
          guestPathEqualsOrWithin(binding.guest_workspace_path, candidate.guest_workspace_path),
      );
      if (shared.length > 0) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "shared_workspace_path",
          message: `目录 ${binding.guest_workspace_path} 同时被其他项目使用；为避免静默覆盖其他项目，拒绝恢复`,
          affectedProjects: shared.map(toProjectReference),
        });
      }
      const vm = await this.db
        .selectFrom("vm_instances")
        .select(["id", "name"])
        .where("id", "=", binding.vm_id)
        .executeTakeFirst();
      const runtime = vm ? await this.supervisor.get(binding.vm_id).catch(() => null) : null;
      if (!vm || runtime?.powerState !== "running") {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "vm_not_running",
          message: `VM「${binding.vm_name}」未运行，无法恢复项目目录`,
          affectedProjects: [],
        });
      }
      const activeTasks = await this.db
        .selectFrom("tasks")
        .select(["id", "project_id"])
        .where("vm_id", "=", binding.vm_id)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .execute();
      const pathProjectIds = new Set(shared.map((project) => project.id));
      if (
        activeTasks.some(
          (task) => task.project_id === projectId || pathProjectIds.has(task.project_id),
        )
      ) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "active_tasks",
          message: `VM「${binding.vm_name}」上仍有活动任务，不能恢复项目目录`,
          affectedProjects: shared.map(toProjectReference),
        });
      }
      const lease = await this.db
        .selectFrom("vm_leases")
        .select(["expires_at"])
        .where("vm_id", "=", binding.vm_id)
        .executeTakeFirst();
      if (lease && Date.parse(lease.expires_at) > Date.now()) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "lease_active",
          message: `VM「${binding.vm_name}」仍有 Execution Lease，不能恢复项目目录`,
          affectedProjects: [],
        });
      }
      const file = binding.file_path ? this.resolveBackupFile(binding.file_path) : null;
      const fileInfo = file ? await stat(file).catch(() => null) : null;
      if (!fileInfo?.isFile()) {
        conflicts.push({
          bindingId: binding.binding_id,
          vmId: binding.vm_id,
          vmName: binding.vm_name,
          reason: "missing_file",
          message: `备份文件缺失：${binding.file_path ?? "unknown"}`,
          affectedProjects: [],
        });
      }
    }
    const otherProjects = await this.bindingsOtherProjects(projectId, bindings);
    const warning =
      "项目级备份只恢复本项目绑定工作目录的文件；共享 VM 的软件、桌面和系统状态不会回滚，其他项目目录保持不变。";
    return {
      backup: toRecord(backup, bindings),
      blocked: conflicts.length > 0,
      conflicts,
      otherProjects,
      warning,
    };
  }

  async restore(
    projectId: string,
    backupId: string,
    input: RestoreProjectBackupRequest,
  ): Promise<ProjectBackupRecord> {
    if (input?.confirm !== true) {
      throw new PersistenceError("conflict", "恢复项目备份需要显式确认");
    }
    const current = await this.requireBackup(projectId, backupId);
    if (current.status !== "available" && current.status !== "restored") {
      throw new PersistenceError("conflict", "只有 available 状态的项目备份可以恢复");
    }
    const impact = await this.impact(projectId, backupId);
    if (impact.blocked) {
      throw new PersistenceError(
        "conflict",
        impact.conflicts[0]?.message ?? "项目备份当前不能恢复",
        { impact },
      );
    }
    const bindings = await this.db
      .selectFrom("project_backup_bindings")
      .selectAll()
      .where("backup_id", "=", backupId)
      .orderBy("id", "asc")
      .execute();
    const claimed = await this.db
      .updateTable("project_backups")
      .set({ status: "restoring", error_message: null })
      .where("id", "=", backupId)
      .where("status", "in", ["available", "restored"])
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) === 0) {
      throw new PersistenceError("conflict", "该备份已被另一个恢复操作占用");
    }
    const restored: string[] = [];
    try {
      for (const binding of bindings) {
        if (!binding.file_path || !binding.sha256) {
          throw new PersistenceError("conflict", `备份绑定 ${binding.binding_id} 缺少文件或哈希`);
        }
        const file = this.resolveBackupFile(binding.file_path);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) {
          throw new PersistenceError("unavailable", `备份文件缺失：${binding.file_path}`);
        }
        const vm = await this.db
          .selectFrom("vm_instances")
          .select(["id", "name", "storage_root"])
          .where("id", "=", binding.vm_id)
          .executeTakeFirst();
        if (!vm) throw new NotFoundError(`VM 不存在：${binding.vm_id}`);
        const runtime = await this.supervisor.get(binding.vm_id);
        if (runtime.powerState !== "running" || !runtime.guestHostPort) {
          throw new PersistenceError("conflict", `VM「${vm.name}」未运行，不能恢复项目目录`);
        }
        const lease = await this.leases.acquire({
          vmId: binding.vm_id,
          owner: "human",
          taskId: null,
          ttlMs: BACKUP_LEASE_TTL_MS,
        });
        try {
          const result = await this.guest.restoreWorkspace(
            { hostPort: runtime.guestHostPort, storageRoot: vm.storage_root },
            binding.guest_workspace_path,
            file,
            binding.sha256,
          );
          await this.db
            .updateTable("project_backup_bindings")
            .set({
              status: "restored",
              size_bytes: result.sizeBytes,
              file_count: result.fileCount,
            })
            .where("id", "=", binding.id)
            .execute();
          restored.push(binding.binding_id);
        } finally {
          await this.leases.release(binding.vm_id, lease.id).catch(() => undefined);
        }
      }
      const now = nowIso();
      await this.db
        .updateTable("project_backups")
        .set({ status: "restored", restored_at: now, completed_at: current.completed_at ?? now })
        .where("id", "=", backupId)
        .execute();
      await this.outbox.append(
        "project.backup_restored",
        { projectId, backupId, bindingIds: restored, otherProjects: impact.otherProjects },
        now,
      );
      return this.get(projectId, backupId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .updateTable("project_backups")
        .set({ status: "failed", error_message: message })
        .where("id", "=", backupId)
        .execute();
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("unavailable", `恢复项目备份失败：${message}`);
    }
  }

  async verify(projectId: string, backupId: string): Promise<ProjectBackupVerifyResult> {
    const backup = await this.requireBackup(projectId, backupId);
    const bindings = await this.db
      .selectFrom("project_backup_bindings")
      .selectAll()
      .where("backup_id", "=", backupId)
      .execute();
    const results: ProjectBackupVerifyResult["bindings"] = [];
    for (const binding of bindings) {
      let exists = false;
      let sha256Matches = false;
      let sizeMatches = false;
      if (binding.file_path && binding.sha256) {
        const file = this.resolveBackupFile(binding.file_path);
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) {
          exists = true;
          sizeMatches = binding.size_bytes === null || info.size === binding.size_bytes;
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file)) {
            hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          sha256Matches = hash.digest("hex") === binding.sha256;
        }
      }
      results.push({
        bindingId: binding.binding_id,
        vmId: binding.vm_id,
        exists,
        sha256Matches,
        sizeMatches,
      });
    }
    const artifactResults: ProjectBackupVerifyResult["artifacts"] = [];
    for (const artifact of parseArtifacts(backup.artifact_snapshot_json)) {
      const file = this.resolveArtifactFile(artifact.relativePath);
      const info = await lstat(file).catch(() => null);
      let exists = false;
      let sha256Matches = false;
      let sizeMatches = false;
      if (info?.isFile()) {
        exists = true;
        sizeMatches = info.size === artifact.sizeBytes;
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) {
          hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        sha256Matches = hash.digest("hex") === artifact.sha256;
      }
      artifactResults.push({
        artifactId: artifact.artifactId,
        relativePath: artifact.relativePath,
        exists,
        sha256Matches,
        sizeMatches,
      });
    }
    return {
      backupId,
      ok:
        results.every((result) => result.exists && result.sha256Matches && result.sizeMatches) &&
        artifactResults.every(
          (result) => result.exists && result.sha256Matches && result.sizeMatches,
        ),
      bindings: results,
      artifacts: artifactResults,
      checkedAt: nowIso(),
    };
  }

  async delete(projectId: string, backupId: string): Promise<{ deleted: true; backupId: string }> {
    const backup = await this.requireBackup(projectId, backupId);
    if (backup.status === "restoring") {
      throw new PersistenceError("conflict", "备份正在恢复，不能删除");
    }
    await rm(this.backupDirectory(projectId, backupId), { recursive: true, force: true }).catch(
      () => undefined,
    );
    await this.db.deleteFrom("project_backups").where("id", "=", backupId).execute();
    await this.outbox.append("project.backup_deleted", { projectId, backupId }, nowIso());
    return { deleted: true, backupId };
  }

  private async assertBindingFree(binding: BindingRow): Promise<void> {
    const [activeTask, workers, lease] = await Promise.all([
      this.db
        .selectFrom("tasks")
        .select("id")
        .where("project_id", "=", binding.project_id)
        .where("vm_id", "=", binding.vm_id)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("workers")
        .select(["id", "status"])
        .where("project_id", "=", binding.project_id)
        .where("vm_id", "=", binding.vm_id)
        .where("status", "in", ["starting", "running", "restoring", "archiving"])
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("vm_leases")
        .select(["expires_at"])
        .where("vm_id", "=", binding.vm_id)
        .executeTakeFirst(),
    ]);
    if (activeTask) throw new PersistenceError("conflict", "项目在该 VM 上仍有活动任务，不能备份");
    if (workers) throw new PersistenceError("conflict", "项目在该 VM 上仍有活动 Worker，不能备份");
    if (lease && Date.parse(lease.expires_at) > Date.now()) {
      throw new PersistenceError("conflict", "VM 仍有 Execution Lease，不能备份项目目录");
    }
  }

  private async requireBindings(projectId: string): Promise<BindingRow[]> {
    return this.db
      .selectFrom("project_vm_bindings")
      .select(["id", "project_id", "vm_id", "guest_workspace_path"])
      .where("project_id", "=", projectId)
      .orderBy("created_at", "asc")
      .execute();
  }

  private async loadVms(
    vmIds: string[],
  ): Promise<Map<string, { id: string; name: string; storage_root: string; power_state: string }>> {
    if (vmIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("vm_instances")
      .select(["id", "name", "storage_root", "power_state"])
      .where("id", "in", [...new Set(vmIds)])
      .execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async projectArtifacts(projectId: string): Promise<ProjectBackupArtifactRef[]> {
    const rows = await this.db
      .selectFrom("task_artifacts")
      .select(["id", "task_id", "name", "relative_path", "sha256", "size_bytes"])
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();
    return rows.map((row) => ({
      artifactId: row.id,
      taskId: row.task_id,
      name: row.name,
      relativePath: row.relative_path,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    }));
  }

  private async bindingsOtherProjects(
    projectId: string,
    bindings: BackupBindingRow[],
  ): Promise<VmProjectReference[]> {
    const vmIds = [...new Set(bindings.map((binding) => binding.vm_id))];
    if (vmIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("project_vm_bindings")
      .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
      .select([
        "projects.id as id",
        "projects.name as name",
        "projects.archived_at as archived_at",
        "project_vm_bindings.is_primary as is_primary",
      ])
      .where("project_vm_bindings.vm_id", "in", vmIds)
      .where("project_vm_bindings.project_id", "!=", projectId)
      .orderBy("projects.created_at", "asc")
      .execute();
    const unique = new Map<string, VmProjectReference>();
    for (const row of rows) {
      if (!unique.has(row.id)) unique.set(row.id, toProjectReference(row));
    }
    return [...unique.values()];
  }

  private async requireProject(projectId: string): Promise<{ id: string; name: string }> {
    const row = await this.db
      .selectFrom("projects")
      .select(["id", "name"])
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`项目不存在：${projectId}`);
    return row;
  }

  private async requireBackup(projectId: string, backupId: string): Promise<BackupRow> {
    const row = await this.db
      .selectFrom("project_backups")
      .selectAll()
      .where("id", "=", backupId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`项目备份不存在：${backupId}`);
    return row;
  }

  private backupDirectory(projectId: string, backupId: string): string {
    return path.resolve(this.database.layout.archives, BACKUP_ROOT, projectId, backupId);
  }

  private resolveArtifactFile(relativePath: string): string {
    const root = path.resolve(this.database.layout.artifacts);
    const file = path.resolve(root, ...relativePath.split("/"));
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relativePath.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new PersistenceError("unavailable", "产物路径越界");
    }
    return file;
  }

  private resolveBackupFile(relativePath: string): string {
    if (
      typeof relativePath !== "string" ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new PersistenceError("unavailable", "项目备份路径无效");
    }
    const root = path.resolve(this.database.layout.archives);
    const file = path.resolve(root, ...relativePath.split("/"));
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new PersistenceError("unavailable", "项目备份路径越界");
    }
    return file;
  }
}

function toRecord(row: BackupRow, bindings: BackupBindingRow[]): ProjectBackupRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    status: row.status as ProjectBackupRecord["status"],
    bindings: bindings.map(toBindingRecord),
    artifactSnapshot: parseArtifacts(row.artifact_snapshot_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    restoredAt: row.restored_at,
    errorMessage: row.error_message,
  };
}

function toBindingRecord(row: BackupBindingRow): ProjectBackupBindingRecord {
  return {
    id: row.id,
    backupId: row.backup_id,
    bindingId: row.binding_id,
    vmId: row.vm_id,
    vmName: row.vm_name,
    guestWorkspacePath: row.guest_workspace_path,
    sizeBytes: row.size_bytes,
    fileCount: row.file_count,
    sha256: row.sha256,
    status: row.status as ProjectBackupBindingRecord["status"],
    errorMessage: row.error_message,
  };
}

function groupBindings(rows: BackupBindingRow[]): Map<string, BackupBindingRow[]> {
  const grouped = new Map<string, BackupBindingRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.backup_id) ?? [];
    list.push(row);
    grouped.set(row.backup_id, list);
  }
  return grouped;
}

function parseArtifacts(value: string): ProjectBackupArtifactRef[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ProjectBackupArtifactRef =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as ProjectBackupArtifactRef).artifactId === "string" &&
        typeof (item as ProjectBackupArtifactRef).sha256 === "string",
    );
  } catch {
    return [];
  }
}

function toProjectReference(row: {
  id: string;
  name: string;
  is_primary: number;
  archived_at: string | null;
}): VmProjectReference {
  return {
    id: row.id,
    name: row.name,
    isPrimary: row.is_primary === 1,
    archivedAt: row.archived_at,
  };
}

function normalizeLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length > 80) {
    throw new PersistenceError("validation_failed", "备份标签不能超过 80 个字符");
  }
  return label || `项目备份 ${new Date().toLocaleString("zh-CN")}`;
}
