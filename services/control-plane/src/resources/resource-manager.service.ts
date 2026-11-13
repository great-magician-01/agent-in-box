import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ResourcePolicy,
  ResourceReconcileResult,
  ResourceReport,
  SupervisorVmState,
  VmPowerState,
} from "@agent-in-box/protocol";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import type { DatabaseSchema } from "../persistence/schema";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskService } from "../persistence/services/task-service";
import { SettingsService } from "../settings/settings.service";
import { SupervisorClient } from "../vms/supervisor.client";
import {
  autoStartDecision,
  buildResourceReport,
  effectiveBudgetBytes,
  idleSuspendDecision,
  isSuspendBlockingWorkerStatus,
  isVmPowerStartable,
  maxIsoTimestamp,
  type ResourceTaskRow,
  type ResourceVmRow,
  type ResourceWorkerRow,
} from "./resource-policy";

export const RESOURCE_MANAGER_OPTIONS = Symbol("AGENT_IN_BOX_RESOURCE_MANAGER_OPTIONS");

export interface ResourceManagerOptions {
  totalMemoryBytes?: () => number;
  freeMemoryBytes?: () => number;
  now?: () => Date;
  tickIntervalMs?: number;
  autoTick?: boolean;
}

/**
 * os.freemem reports sysinfo.freeram on Linux, which excludes reclaimable page
 * cache and can be near zero on a healthy host. Prefer MemAvailable so the
 * soft-budget guard does not block every auto-start after normal disk I/O.
 */
function hostFreeMemoryBytes(): number {
  if (process.platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
      if (match?.[1]) return Number(match[1]) * 1024;
    } catch {
      // Fall back to the portable counter when /proc is unavailable.
    }
  }
  return freemem();
}

interface IdleTaskRow extends ResourceTaskRow {
  updated_at: string;
}

interface IdleWorkerRow extends ResourceWorkerRow {
  last_active_at: string;
}

@Injectable()
export class ResourceManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResourceManagerService.name);
  private readonly totalMemoryBytes: () => number;
  private readonly freeMemoryBytes: () => number;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly autoTick: boolean;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly settings: SettingsService,
    private readonly supervisor: SupervisorClient,
    private readonly tasks: TaskService,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(RESOURCE_MANAGER_OPTIONS) options: ResourceManagerOptions = {},
  ) {
    this.totalMemoryBytes = options.totalMemoryBytes ?? (() => totalmem());
    this.freeMemoryBytes = options.freeMemoryBytes ?? hostFreeMemoryBytes;
    this.now = options.now ?? (() => new Date());
    const envTick = Number(process.env.AGENT_IN_BOX_RESOURCE_TICK_MS);
    const defaultTick = Number.isFinite(envTick) && envTick > 0 ? envTick : 5000;
    this.tickIntervalMs = Math.max(1000, options.tickIntervalMs ?? defaultTick);
    this.autoTick = options.autoTick ?? true;
  }

  onModuleInit(): void {
    if (!this.autoTick) return;
    setTimeout(() => void this.tick(), 0).unref();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async report(): Promise<ResourceReport> {
    const totalMemory = this.totalMemoryBytes();
    const policy = await this.settings.resourcePolicy(totalMemory);
    return this.buildReport(policy, totalMemory);
  }

  async reconcile(): Promise<ResourceReconcileResult> {
    const now = this.now();
    const totalMemory = this.totalMemoryBytes();
    const policy = await this.settings.resourcePolicy(totalMemory);
    const report = await this.buildReport(policy, totalMemory);
    const startedVmIds: string[] = [];
    const resumedVmIds: string[] = [];
    const suspendedVmIds: string[] = [];
    const waitingTaskIds: string[] = [];

    if (policy.autoStartPolicy === "when_needed") {
      await this.autoStartWaitingVms(policy, report, {
        now,
        startedVmIds,
        resumedVmIds,
        waitingTaskIds,
      });
    }
    if (policy.idleSuspendEnabled) {
      await this.suspendIdleVms(policy, now, suspendedVmIds);
    }

    if (
      startedVmIds.length + resumedVmIds.length + suspendedVmIds.length + waitingTaskIds.length >
      0
    ) {
      await this.outbox.append(
        "resource.changed",
        {
          startedVmIds,
          resumedVmIds,
          suspendedVmIds,
          waitingTaskIds,
        },
        nowIso(),
      );
    }
    return {
      report: await this.report(),
      startedVmIds,
      resumedVmIds,
      suspendedVmIds,
      waitingTaskIds,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(
        `Resource reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async buildReport(
    policy: ResourcePolicy,
    totalMemoryBytes: number,
  ): Promise<ResourceReport> {
    const [vms, tasks, workers] = await Promise.all([
      this.db
        .selectFrom("vm_instances")
        .select(["id", "name", "power_state", "memory_bytes", "created_at", "last_started_at"])
        .orderBy("created_at", "asc")
        .execute(),
      this.db.selectFrom("tasks").select(["vm_id", "status", "updated_at"]).execute(),
      this.db.selectFrom("workers").select(["vm_id", "status", "last_active_at"]).execute(),
    ]);
    return buildResourceReport({
      now: nowIso(),
      totalMemoryBytes,
      freeMemoryBytes: this.freeMemoryBytes(),
      policy,
      vms: vms as ResourceVmRow[],
      tasks,
      workers,
    });
  }

  private async autoStartWaitingVms(
    policy: ResourcePolicy,
    report: ResourceReport,
    result: {
      now: Date;
      startedVmIds: string[];
      resumedVmIds: string[];
      waitingTaskIds: string[];
    },
  ): Promise<void> {
    const [vms, waitingTasks] = await Promise.all([
      this.db
        .selectFrom("vm_instances")
        .select(["id", "name", "power_state", "memory_bytes"])
        .orderBy("created_at", "asc")
        .execute(),
      this.db
        .selectFrom("tasks")
        .select(["id", "vm_id", "status", "project_id"])
        .where("status", "in", ["waiting_vm", "waiting_resources"])
        .orderBy("priority", "desc")
        .orderBy("created_at", "asc")
        .execute(),
    ]);
    if (waitingTasks.length === 0) return;

    const budgetBytes = effectiveBudgetBytes(policy, this.totalMemoryBytes());
    let projectedAllocated = report.allocatedMemoryBytes;
    const freeMemoryBytes = this.freeMemoryBytes();
    const waitingByVm = new Map<string, typeof waitingTasks>();
    for (const task of waitingTasks) {
      const list = waitingByVm.get(task.vm_id) ?? [];
      list.push(task);
      waitingByVm.set(task.vm_id, list);
    }

    for (const vm of vms) {
      const tasks = waitingByVm.get(vm.id) ?? [];
      if (tasks.length === 0 || !isVmPowerStartable(vm.power_state)) continue;
      const projectRows = await this.db
        .selectFrom("projects")
        .select(["id", "archived_at"])
        .where(
          "id",
          "in",
          tasks.map((task) => task.project_id),
        )
        .execute();
      const activeProjectIds = new Set(
        projectRows.filter((project) => project.archived_at === null).map((project) => project.id),
      );
      if (!tasks.some((task) => activeProjectIds.has(task.project_id))) continue;

      const decision = autoStartDecision({
        requiredBytes: vm.memory_bytes,
        allocatedBytes: projectedAllocated,
        budgetBytes,
        freeMemoryBytes,
        hostReserveBytes: policy.hostReserveBytes,
      });
      if (!decision.canStart) {
        const movable = tasks.filter((task) => task.status === "waiting_vm");
        if (movable.length > 0) {
          const updated = await this.tasks.markWaitingResources(vm.id, decision.reason ?? "");
          result.waitingTaskIds.push(...updated.map((task) => task.id));
          await this.outbox.append(
            "resource.waiting_for_memory",
            {
              vmId: vm.id,
              vmName: vm.name,
              taskIds: updated.map((task) => task.id),
              requiredBytes: vm.memory_bytes,
              allocatedBytes: projectedAllocated,
              budgetBytes,
              reason: decision.reason,
            },
            nowIso(),
          );
        }
        continue;
      }

      try {
        const resumed = vm.power_state === "suspended";
        const state = resumed
          ? await this.supervisor.resume(vm.id)
          : await this.supervisor.start(vm.id);
        await this.persistPower(vm.id, state, "resource_auto_start");
        await this.tasks.reconcileVm(vm.id);
        projectedAllocated += vm.memory_bytes;
        if (resumed) result.resumedVmIds.push(vm.id);
        else result.startedVmIds.push(vm.id);
        await this.outbox.append(
          "resource.vm_auto_started",
          {
            vmId: vm.id,
            vmName: vm.name,
            mode: resumed ? "resume" : "start",
            taskIds: tasks.map((task) => task.id),
            requiredBytes: vm.memory_bytes,
            allocatedBytes: projectedAllocated,
            budgetBytes,
          },
          nowIso(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Auto-start failed for VM ${vm.id}: ${message}`);
        await this.outbox.append(
          "resource.auto_start_failed",
          { vmId: vm.id, vmName: vm.name, error: message },
          nowIso(),
        );
      }
    }
  }

  private async suspendIdleVms(
    policy: ResourcePolicy,
    now: Date,
    suspendedVmIds: string[],
  ): Promise<void> {
    const [vms, tasks, workers, leases] = await Promise.all([
      this.db
        .selectFrom("vm_instances")
        .select(["id", "name", "power_state", "created_at", "last_started_at"])
        .where("power_state", "=", "running")
        .execute(),
      this.db.selectFrom("tasks").select(["vm_id", "status", "updated_at"]).execute(),
      this.db.selectFrom("workers").select(["vm_id", "status", "last_active_at"]).execute(),
      this.db.selectFrom("vm_leases").select(["vm_id", "expires_at"]).execute(),
    ]);
    if (vms.length === 0) return;

    const activeTaskCount = new Map<string, number>();
    const latestTaskAt = new Map<string, string>();
    for (const task of tasks as IdleTaskRow[]) {
      if (
        [
          "created",
          "waiting_resources",
          "waiting_vm",
          "queued",
          "running",
          "waiting_approval",
          "waiting_human",
          "blocked",
        ].includes(task.status)
      ) {
        activeTaskCount.set(task.vm_id, (activeTaskCount.get(task.vm_id) ?? 0) + 1);
      }
      latestTaskAt.set(
        task.vm_id,
        maxIsoTimestamp([latestTaskAt.get(task.vm_id), task.updated_at]) ?? task.updated_at,
      );
    }
    const attachedWorkers = new Map<string, number>();
    const latestWorkerAt = new Map<string, string>();
    for (const worker of workers as IdleWorkerRow[]) {
      if (isSuspendBlockingWorkerStatus(worker.status)) {
        attachedWorkers.set(worker.vm_id, (attachedWorkers.get(worker.vm_id) ?? 0) + 1);
      }
      latestWorkerAt.set(
        worker.vm_id,
        maxIsoTimestamp([latestWorkerAt.get(worker.vm_id), worker.last_active_at]) ??
          worker.last_active_at,
      );
    }
    const leaseVmIds = new Set(
      leases
        .filter((lease) => Date.parse(lease.expires_at) > now.getTime())
        .map((lease) => lease.vm_id),
    );

    for (const vm of vms) {
      const blockers: string[] = [];
      if ((activeTaskCount.get(vm.id) ?? 0) > 0) blockers.push("active_tasks");
      if ((attachedWorkers.get(vm.id) ?? 0) > 0) blockers.push("worker_connected");
      if (leaseVmIds.has(vm.id)) blockers.push("execution_lease");
      const idleSince = new Date(
        Date.parse(
          maxIsoTimestamp([
            vm.last_started_at ?? vm.created_at,
            latestTaskAt.get(vm.id),
            latestWorkerAt.get(vm.id),
          ]) ?? vm.created_at,
        ),
      );
      const decision = idleSuspendDecision({ now, idleSince, policy, blockers });
      if (!decision.eligible) continue;
      try {
        const state = await this.supervisor.suspend(vm.id);
        await this.persistPower(vm.id, state, "resource_idle_suspend");
        suspendedVmIds.push(vm.id);
        await this.outbox.append(
          "resource.vm_idle_suspended",
          {
            vmId: vm.id,
            vmName: vm.name,
            idleSince: idleSince.toISOString(),
            timeoutMs: policy.idleSuspendTimeoutMs,
          },
          nowIso(),
        );
      } catch (error) {
        this.logger.warn(
          `Idle suspend failed for VM ${vm.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async persistPower(
    vmId: string,
    state: SupervisorVmState,
    trigger: "resource_auto_start" | "resource_idle_suspend",
  ): Promise<void> {
    const current = await this.db
      .selectFrom("vm_instances")
      .select(["power_state"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!current) return;
    const now = nowIso();
    const to = state.powerState as VmPowerState;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("vm_instances")
        .set({
          power_state: to,
          guest_health: "unknown",
          ...(to === "running" && current.power_state !== "running"
            ? { last_started_at: now }
            : {}),
        })
        .where("id", "=", vmId)
        .execute();
      if (current.power_state !== to) {
        await trx
          .insertInto("outbox")
          .values({
            topic: "vm.power_changed",
            payload_json: JSON.stringify({ vmId, from: current.power_state, to, trigger }),
            created_at: now,
            published_at: null,
            attempts: 0,
            last_error: null,
          })
          .execute();
      }
    });
  }
}
