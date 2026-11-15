import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type {
  GuestHealthState,
  ResourceReport,
  SupervisorVmState,
  VmActiveWorkerView,
  VmConsole,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  VmPowerState,
  VmQueueItem,
  VmSchedulingView,
  VmSharingView,
  SupervisorAvailability,
} from "@agent-in-box/protocol";
import type { Kysely } from "kysely";
import { ImageService } from "../images/image.service";
import { DatabaseService } from "../persistence/database.service";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import { toVmInstanceRecord } from "../persistence/mappers";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { TaskService } from "../persistence/services/task-service";
import { ResourceManagerService } from "../resources/resource-manager.service";
import {
  autoStartDecision,
  isSuspendBlockingWorkerStatus,
  maxIsoTimestamp,
} from "../resources/resource-policy";
import { directoryStats } from "../storage/fs-utils";
import { ProvisioningService } from "../provisioning/provisioning.service";
import { SupervisorClient } from "./supervisor.client";

const GIB = 1024 * 1024 * 1024;

async function writeToken(file: string): Promise<void> {
  await writeFile(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
}
const ACTIVE_TASK_STATUSES = [
  "created",
  "waiting_resources",
  "waiting_vm",
  "queued",
  "running",
  "waiting_approval",
  "waiting_human",
  "blocked",
] as const;

export const VM_SERVICE_OPTIONS = Symbol("AGENT_IN_BOX_VM_SERVICE_OPTIONS");
export interface VmServiceOptions {
  guestFetchImpl?: typeof fetch;
  guestTimeoutMs?: number;
}

@Injectable()
export class VmService {
  private readonly guestFetch: typeof fetch;
  private readonly guestTimeoutMs: number;
  private readonly logger = new Logger(VmService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly images: ImageService,
    private readonly supervisor: SupervisorClient,
    @Optional() @Inject(VM_SERVICE_OPTIONS) options: VmServiceOptions = {},
    @Optional() private readonly tasks?: TaskService,
    @Optional() private readonly resources?: ResourceManagerService,
    @Optional() private readonly provisioning?: ProvisioningService,
  ) {
    this.guestFetch = options.guestFetchImpl ?? fetch;
    this.guestTimeoutMs = options.guestTimeoutMs ?? 1000;
  }

  async list(): Promise<VmListResponse> {
    const rows = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    let states = new Map<string, SupervisorVmState>();
    let availability: SupervisorAvailability = { available: true, message: null };
    try {
      states = new Map((await this.supervisor.list()).map((state) => [state.id, state]));
    } catch (error) {
      availability = {
        available: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const runtimes = new Map<string, SupervisorVmState | null>();
    for (const row of rows) {
      let runtime = states.get(row.id) ?? null;
      if (availability.available) {
        if (!runtime) {
          await this.persistState(row.id, "error", "unknown", null, "Supervisor 中缺少 VM 元数据");
        } else {
          runtime = await this.withGuestHealth(runtime);
          await this.persistState(row.id, runtime.powerState, runtime.guestHealth, runtime, null);
        }
      }
      await this.tasks?.reconcileVm(row.id);
      runtimes.set(row.id, runtime);
    }
    const report = await this.resourceReport();
    const items = await Promise.all(
      rows.map((row) => this.view(row.id, runtimes.get(row.id) ?? null, report)),
    );
    return { items, supervisor: availability };
  }

  async create(input: VmCreateRequest): Promise<VmInstanceView> {
    if (typeof input !== "object" || input === null) {
      throw new PersistenceError("validation_failed", "VM 创建参数无效");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 64) {
      throw new PersistenceError("validation_failed", "VM 名称必须为 1～64 个字符");
    }
    if (!Number.isInteger(input.cpuCount) || input.cpuCount < 1 || input.cpuCount > 32) {
      throw new PersistenceError("validation_failed", "CPU 必须为 1～32 核");
    }
    if (!Number.isInteger(input.memoryGb) || input.memoryGb < 1 || input.memoryGb > 64) {
      throw new PersistenceError("validation_failed", "内存必须为 1～64 GiB 整数");
    }
    if (!Number.isInteger(input.diskGb) || input.diskGb < 1 || input.diskGb > 2048) {
      throw new PersistenceError("validation_failed", "磁盘必须为 1～2048 GiB 整数");
    }
    if (typeof input.imageId !== "string" || !input.imageId) {
      throw new PersistenceError("validation_failed", "必须选择一个镜像");
    }
    if (
      input.provisioning !== undefined &&
      input.provisioning !== "auto" &&
      input.provisioning !== "none"
    ) {
      throw new PersistenceError("validation_failed", "provisioning 必须是 auto 或 none");
    }
    const image = await this.images.get(input.imageId);
    if (image.status !== "available" || !image.localPath || !image.verifiedAt) {
      throw new PersistenceError("conflict", "只有校验通过的 Available 镜像可以创建 VM");
    }
    if (image.osFamily === "windows") {
      if (input.memoryGb < 4) {
        throw new PersistenceError("validation_failed", "Windows Guest 至少需要 4 GiB 内存");
      }
      if (input.diskGb < 32) {
        throw new PersistenceError("validation_failed", "Windows Guest 至少需要 32 GiB 磁盘");
      }
    }
    const seedImagePath = input.seedImagePath?.trim() || image.seedLocalPath || "";
    if (seedImagePath) {
      if (!path.isAbsolute(seedImagePath)) {
        throw new PersistenceError("validation_failed", "Seed/Provisioning 介质必须使用绝对路径");
      }
      const info = await lstat(seedImagePath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new PersistenceError(
          "validation_failed",
          "Seed/Provisioning 介质必须是可读取的普通文件",
        );
      }
    }

    const id = randomUUID();
    const storageRoot = path.join(this.database.layout.vms, id);
    const profile = image.provisioningProfile;
    const autoProvision =
      !seedImagePath &&
      input.provisioning !== "none" &&
      profile === "linux-desktop-worker" &&
      image.osFamily === "linux";
    let provisioningUrl: string | undefined;
    if (autoProvision) {
      if (!profile || !this.provisioning?.availableFor(profile)) {
        throw new PersistenceError(
          "unavailable",
          this.provisioning?.unavailableMessage() ??
            "Cloud-init provisioning 不可用；请先打包 Guest Runtime 资产",
        );
      }
      await mkdir(storageRoot, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeToken(path.join(storageRoot, "guest-agent.token")),
        writeToken(path.join(storageRoot, "worker-rpc.token")),
      ]);
      provisioningUrl = this.provisioning.contextFor(id).url;
    }
    const runtime = await this.supervisor.create({
      id,
      name,
      osFamily: image.osFamily,
      baseImagePath: image.localPath,
      seedImagePath,
      ...(provisioningUrl ? { provisioningUrl } : {}),
      cpuCount: input.cpuCount,
      memoryMb: input.memoryGb * 1024,
      diskSizeGb: input.diskGb,
      desktop: true,
      qmpPort: 0,
      sshHostPort: 0,
      guestHostPort: 0,
      workerHostPort: 0,
      vncDisplay: 0,
    });
    const now = nowIso();
    await this.db
      .insertInto("vm_instances")
      .values({
        id,
        name,
        image_id: image.id,
        os_family: image.osFamily,
        cpu_count: input.cpuCount,
        memory_bytes: input.memoryGb * GIB,
        disk_bytes: input.diskGb * GIB,
        storage_root: storageRoot,
        power_state: "stopped",
        guest_health: "unknown",
        created_at: now,
        last_started_at: null,
        provisioning_state: provisioningUrl ? "waiting" : "none",
        provisioning_message: provisioningUrl
          ? "VM 已创建；首次启动时由 cloud-init 安装桌面与 Worker"
          : null,
        provisioning_started_at: null,
      })
      .execute();
    if (provisioningUrl) await this.provisioning?.markStarting(id);
    return this.view(id, runtime, await this.resourceReport());
  }

  async get(id: string): Promise<VmInstanceView> {
    await this.requireVm(id);
    let runtime: SupervisorVmState | null = null;
    try {
      runtime = await this.withGuestHealth(await this.supervisor.get(id));
      await this.persistState(id, runtime.powerState, runtime.guestHealth, runtime, null);
      await this.tasks?.reconcileVm(id);
    } catch {
      // Keep the persisted VM view available when the Supervisor is down.
    }
    return this.view(id, runtime, await this.resourceReport());
  }

  start(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.start(id));
  }

  stop(id: string, mode: "graceful" | "force" = "graceful"): Promise<VmInstanceView> {
    if (mode !== "graceful" && mode !== "force") {
      throw new PersistenceError("validation_failed", "停止模式必须是 graceful 或 force");
    }
    return this.action(id, () => this.supervisor.stop(id, mode));
  }

  suspend(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.suspend(id));
  }

  resume(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.resume(id));
  }

  async delete(id: string): Promise<{ deleted: true; vmId: string }> {
    const vm = await this.requireVm(id);
    const [bindings, task, worker, archive, backup, leaseRows] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
        .select(["projects.name as name"])
        .where("project_vm_bindings.vm_id", "=", id)
        .execute(),
      this.db.selectFrom("tasks").select("id").where("vm_id", "=", id).limit(1).executeTakeFirst(),
      this.db
        .selectFrom("workers")
        .select("id")
        .where("vm_id", "=", id)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("worker_archives")
        .select("id")
        .where("vm_id", "=", id)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("project_backup_bindings")
        .select(["backup_id"])
        .where("vm_id", "=", id)
        .limit(1)
        .executeTakeFirst(),
      this.db.selectFrom("vm_leases").select(["expires_at"]).where("vm_id", "=", id).execute(),
    ]);
    const activeLease = leaseRows.some((row) => Date.parse(row.expires_at) > Date.now());
    if (bindings.length > 0) {
      throw new PersistenceError(
        "conflict",
        `VM 仍绑定项目：${bindings.map((binding) => binding.name).join("、")}；请先解除全部绑定`,
        { dependencies: { bindings: bindings.map((binding) => binding.name) } },
      );
    }
    if (task) {
      throw new PersistenceError("conflict", "VM 已有任务历史，不能删除；请保留 VM 或先归档项目", {
        dependencies: { tasks: true },
      });
    }
    if (worker || archive) {
      throw new PersistenceError("conflict", "VM 已有 Worker 或归档历史，不能删除", {
        dependencies: { workers: Boolean(worker), workerArchives: Boolean(archive) },
      });
    }
    if (backup) {
      throw new PersistenceError("conflict", "VM 被项目备份引用，请先删除相关项目备份", {
        dependencies: { projectBackupId: backup.backup_id },
      });
    }
    if (activeLease) {
      throw new PersistenceError("conflict", "VM 仍有活动 Execution Lease，不能删除");
    }
    const runtime = await this.supervisor.get(id);
    if (runtime.powerState !== "stopped") {
      throw new PersistenceError("conflict", "删除 VM 前必须完全停止（stopped）VM");
    }
    const now = nowIso();
    // Delete the database rows first. Foreign-key restrictions make this the
    // authoritative dependency check, so a concurrent bind/task rolls the
    // transaction back while the supervisor directory is still intact. Only
    // after the commit do we remove the disk; a cleanup failure leaves an
    // orphan directory instead of a live row pointing at a missing disk.
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("vm_snapshots").where("vm_id", "=", id).execute();
      await trx.deleteFrom("vm_instances").where("id", "=", id).execute();
      await trx
        .insertInto("outbox")
        .values({
          topic: "vm.deleted",
          payload_json: JSON.stringify({ vmId: id, name: vm.name }),
          created_at: now,
          published_at: null,
          attempts: 0,
          last_error: null,
        })
        .execute();
    });
    await this.supervisor.delete(id).catch((error: unknown) => {
      this.logger.warn(
        `VM ${id} 的数据库记录已删除，但 Supervisor 目录清理失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return { deleted: true, vmId: id };
  }

  async console(id: string): Promise<VmConsole> {
    const vm = await this.requireVm(id);
    const runtime = await this.withGuestHealth(await this.supervisor.get(id));
    await this.persistState(id, runtime.powerState, runtime.guestHealth, runtime, null);
    if (runtime.powerState !== "running" && runtime.powerState !== "suspended") {
      throw new PersistenceError("conflict", "只有运行或休眠中的 VM 可以连接控制台");
    }
    return {
      vmId: vm.id,
      consoleUrl: await this.supervisor.console(id),
      message:
        "QEMU VNC 仅绑定回环地址。请通过阶段 4 的 noVNC 会话建立连接；人工输入由统一 Execution Lease 保护。",
    };
  }

  private async action(
    id: string,
    operation: () => Promise<SupervisorVmState>,
  ): Promise<VmInstanceView> {
    await this.requireVm(id);
    try {
      const state = await this.withGuestHealth(await operation());
      await this.persistState(id, state.powerState, state.guestHealth, state, null);
      await this.tasks?.reconcileVm(id);
      return this.view(id, state, await this.resourceReport());
    } catch (error) {
      // A failed supervisor call does not prove the VM changed power state.
      // Keep the last known state instead of marking a running VM as "error",
      // which would make Workers block their tasks and disable auto-start.
      this.logger.warn(
        `VM ${id} action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async getRecord(id: string) {
    return this.requireVm(id);
  }

  private async requireVm(id: string) {
    const row = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundError(`VM 不存在：${id}`);
    }
    return toVmInstanceRecord(row);
  }

  private async withGuestHealth(state: SupervisorVmState): Promise<SupervisorVmState> {
    let guestHealth: GuestHealthState = "unknown";
    if (state.powerState === "running" && state.guestHostPort > 0) {
      try {
        const guestHost =
          process.env.AGENT_IN_BOX_GUEST_LOOPBACK_HOST?.trim() || "127.0.0.2";
        const response = await this.guestFetch(`http://${guestHost}:${state.guestHostPort}/healthz`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.guestTimeoutMs),
        });
        guestHealth = response.ok ? "healthy" : "unreachable";
      } catch {
        guestHealth = "unreachable";
      }
    } else if (state.powerState === "running") {
      guestHealth = "unreachable";
    }
    return { ...state, guestHealth };
  }

  private async persistState(
    id: string,
    powerState: VmPowerState,
    guestHealth: GuestHealthState,
    runtime: SupervisorVmState | null,
    lastError: string | null,
  ): Promise<void> {
    const current = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!current) {
      return;
    }
    const now = nowIso();
    const changed = current.power_state !== powerState;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("vm_instances")
        .set({
          power_state: powerState,
          guest_health: guestHealth,
          last_started_at:
            powerState === "running" && current.power_state !== "running"
              ? now
              : current.last_started_at,
        })
        .where("id", "=", id)
        .execute();
      if (changed) {
        await trx
          .insertInto("outbox")
          .values({
            topic: "vm.power_changed",
            payload_json: JSON.stringify({
              vmId: id,
              from: current.power_state,
              to: powerState,
              ...(lastError ? { error: lastError } : {}),
            }),
            created_at: now,
            published_at: null,
            attempts: 0,
            last_error: null,
          })
          .execute();
      }
    });
  }

  private async resourceReport(): Promise<ResourceReport | null> {
    if (!this.resources) return null;
    try {
      return await this.resources.report();
    } catch {
      return null;
    }
  }

  private async view(
    id: string,
    runtime: SupervisorVmState | null,
    report: ResourceReport | null,
  ): Promise<VmInstanceView> {
    const vm = await this.requireVm(id);
    const [bindings, taskRows, workerRows, allTaskTimes, lease, usage] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
        .select([
          "projects.id as id",
          "projects.name as name",
          "project_vm_bindings.is_primary as is_primary",
          "projects.archived_at as archived_at",
        ])
        .where("project_vm_bindings.vm_id", "=", id)
        .execute(),
      this.db
        .selectFrom("tasks")
        .innerJoin("projects", "projects.id", "tasks.project_id")
        .select([
          "tasks.id as id",
          "tasks.project_id as project_id",
          "projects.name as project_name",
          "tasks.objective as objective",
          "tasks.status as status",
          "tasks.priority as priority",
          "tasks.created_at as created_at",
          "tasks.updated_at as updated_at",
        ])
        .where("tasks.vm_id", "=", id)
        .where("tasks.status", "in", ACTIVE_TASK_STATUSES)
        .orderBy("tasks.priority", "desc")
        .orderBy("tasks.created_at", "asc")
        .execute(),
      this.db
        .selectFrom("workers")
        .innerJoin("projects", "projects.id", "workers.project_id")
        .select([
          "workers.id as id",
          "workers.project_id as project_id",
          "projects.name as project_name",
          "workers.status as status",
          "workers.current_task_id as current_task_id",
          "workers.last_active_at as last_active_at",
        ])
        .where("workers.vm_id", "=", id)
        .where("workers.status", "not in", ["archived", "failed"])
        .orderBy("workers.created_at", "asc")
        .execute(),
      this.db.selectFrom("tasks").select(["updated_at"]).where("vm_id", "=", id).execute(),
      this.db
        .selectFrom("vm_leases")
        .select(["id", "owner", "expires_at"])
        .where("vm_id", "=", id)
        .executeTakeFirst(),
      directoryStats(vm.storageRoot).catch(() => ({ bytes: 0, files: 0 })),
    ]);
    const boundProjects = bindings.map((binding) => ({
      id: binding.id,
      name: binding.name,
      isPrimary: binding.is_primary === 1,
      archivedAt: binding.archived_at,
    }));
    const queued = taskRows.filter((task) => task.status === "queued");
    const queue: VmQueueItem[] = taskRows.map((task) => ({
      taskId: task.id,
      projectId: task.project_id,
      projectName: task.project_name,
      objective: task.objective,
      status: task.status as VmQueueItem["status"],
      priority: task.priority,
      queuePosition:
        task.status === "queued"
          ? queued.findIndex((candidate) => candidate.id === task.id) + 1
          : null,
      createdAt: task.created_at,
    }));
    const activeWorkers: VmActiveWorkerView[] = workerRows.map((worker) => ({
      workerId: worker.id,
      projectId: worker.project_id,
      projectName: worker.project_name,
      status: worker.status as VmActiveWorkerView["status"],
      currentTaskId: worker.current_task_id,
      lastActiveAt: worker.last_active_at,
    }));
    const sharing: VmSharingView = {
      shared: boundProjects.length > 1,
      projectCount: boundProjects.length,
      projects: boundProjects,
      warning:
        boundProjects.length > 1
          ? `共享 VM：${boundProjects.map((project) => project.name).join("、")} 共用桌面、软件和系统状态；整机快照与系统级变更会影响全部绑定项目。`
          : null,
    };
    const scheduling = this.schedulingView({
      vm,
      report,
      queue,
      allTaskTimes: allTaskTimes.map((row) => row.updated_at),
      activeWorkers,
      leaseExpiresAt: lease?.expires_at ?? null,
    });
    const current = taskRows[0];
    return {
      vm,
      runtime,
      diskUsageBytes: usage.bytes,
      boundProjects,
      currentTask: current
        ? {
            id: current.id,
            objective: current.objective,
            status: current.status as NonNullable<VmInstanceView["currentTask"]>["status"],
          }
        : null,
      queue,
      activeWorkers,
      sharing,
      scheduling,
    };
  }

  private schedulingView(input: {
    vm: ReturnType<typeof toVmInstanceRecord>;
    report: ResourceReport | null;
    queue: VmQueueItem[];
    allTaskTimes: string[];
    activeWorkers: VmActiveWorkerView[];
    leaseExpiresAt: string | null;
  }): VmSchedulingView {
    const report = input.report;
    const power = input.vm.powerState;
    const startable = power === "stopped" || power === "suspended";
    const waitingCount = input.queue.filter(
      (item) => item.status === "waiting_vm" || item.status === "waiting_resources",
    ).length;
    let canAutoStart = false;
    let blockedReason: string | null = null;
    if (report && report.autoStartPolicy === "when_needed" && startable && waitingCount > 0) {
      const decision = autoStartDecision({
        requiredBytes: input.vm.memoryBytes,
        allocatedBytes: report.allocatedMemoryBytes,
        budgetBytes: report.effectiveBudgetBytes,
        freeMemoryBytes: report.freeMemoryBytes,
        hostReserveBytes: report.hostReserveBytes,
      });
      canAutoStart = decision.canStart;
      blockedReason = decision.reason;
    }
    const blockers: string[] = [];
    if (input.queue.length > 0) blockers.push("active_tasks");
    if (input.activeWorkers.some((worker) => isSuspendBlockingWorkerStatus(worker.status))) {
      blockers.push("worker_connected");
    }
    if (input.leaseExpiresAt && Date.parse(input.leaseExpiresAt) > Date.now()) {
      blockers.push("execution_lease");
    }
    const idleSince = new Date(
      Date.parse(
        maxIsoTimestamp([
          input.vm.lastStartedAt ?? input.vm.createdAt,
          ...input.allTaskTimes,
          ...input.activeWorkers.map((worker) => worker.lastActiveAt),
        ]) ?? input.vm.createdAt,
      ),
    );
    const idleSuspendEligibleAt = report?.idleSuspendEnabled
      ? new Date(idleSince.getTime() + report.idleSuspendTimeoutMs).toISOString()
      : null;
    const warnings: string[] = [];
    if (report && startable && input.vm.memoryBytes > report.remainingBudgetBytes) {
      warnings.push("手动启动会超出 Soft Memory Budget；允许手动启动，但可能造成宿主机卡顿。");
    }
    return {
      autoStartPolicy: report?.autoStartPolicy ?? "manual",
      canAutoStart,
      blockedReason,
      idleSuspendEnabled: report?.idleSuspendEnabled ?? false,
      idleSuspendEligibleAt,
      idleSuspendBlockers: blockers,
      warnings,
    };
  }
}
