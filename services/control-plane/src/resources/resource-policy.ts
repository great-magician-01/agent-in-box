import {
  ACTIVE_TASK_STATUSES,
  type ResourceBlockedStart,
  type ResourcePolicy,
  type ResourcePressure,
  type ResourceReport,
  type VmPowerState,
  type VmResourceAllocation,
} from "@agent-in-box/protocol";
export const SUSPEND_BLOCKING_WORKER_STATUSES = [
  "starting",
  "running",
  "idle",
  "archiving",
  "restoring",
] as const;

const ACTIVE_TASK_STATUS_SET = new Set<string>(ACTIVE_TASK_STATUSES);

export interface ResourceVmRow {
  id: string;
  name: string;
  power_state: string;
  memory_bytes: number;
  created_at: string;
  last_started_at: string | null;
}

export interface ResourceTaskRow {
  vm_id: string;
  status: string;
}

export interface ResourceWorkerRow {
  vm_id: string;
  status: string;
}

export interface BuildResourceReportInput {
  now: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  policy: ResourcePolicy;
  vms: readonly ResourceVmRow[];
  tasks: readonly ResourceTaskRow[];
  workers: readonly ResourceWorkerRow[];
}

export function effectiveBudgetBytes(policy: ResourcePolicy, totalMemoryBytes: number): number {
  if (policy.softMemoryBudgetBytes > 0) {
    return totalMemoryBytes > 0
      ? Math.min(policy.softMemoryBudgetBytes, totalMemoryBytes)
      : policy.softMemoryBudgetBytes;
  }
  return Math.max(0, totalMemoryBytes - policy.hostReserveBytes);
}

export function isVmPowerStartable(powerState: string): boolean {
  return powerState === "stopped" || powerState === "suspended";
}

export function buildResourceReport(input: BuildResourceReportInput): ResourceReport {
  const budgetBytes = effectiveBudgetBytes(input.policy, input.totalMemoryBytes);
  const workerCounts = countByVm(input.workers, (worker) => isWorkerAttached(worker.status));
  const activeTaskCounts = countByVm(input.tasks, (task) =>
    ACTIVE_TASK_STATUS_SET.has(task.status),
  );
  const queuedTaskCounts = countByVm(input.tasks, (task) => task.status === "queued");
  const waitingVmCounts = countByVm(input.tasks, (task) => task.status === "waiting_vm");
  const waitingResourceCounts = countByVm(
    input.tasks,
    (task) => task.status === "waiting_resources",
  );

  const allocations: VmResourceAllocation[] = input.vms.map((vm) => ({
    vmId: vm.id,
    vmName: vm.name,
    powerState: vm.power_state as VmPowerState,
    memoryBytes: vm.memory_bytes,
    activeTaskCount: activeTaskCounts.get(vm.id) ?? 0,
    queuedTaskCount: queuedTaskCounts.get(vm.id) ?? 0,
    activeWorkerCount: workerCounts.get(vm.id) ?? 0,
  }));

  const allocatedMemoryBytes = input.vms
    .filter((vm) => vm.power_state === "running")
    .reduce((total, vm) => total + vm.memory_bytes, 0);
  const remainingBudgetBytes = Math.max(0, budgetBytes - allocatedMemoryBytes);
  const blockedAutoStarts: ResourceBlockedStart[] = [];

  if (input.policy.autoStartPolicy === "when_needed") {
    for (const vm of input.vms) {
      if (!isVmPowerStartable(vm.power_state)) continue;
      const waiting = (waitingVmCounts.get(vm.id) ?? 0) + (waitingResourceCounts.get(vm.id) ?? 0);
      if (waiting === 0) continue;
      const decision = autoStartDecision({
        requiredBytes: vm.memory_bytes,
        allocatedBytes: allocatedMemoryBytes,
        budgetBytes,
        freeMemoryBytes: input.freeMemoryBytes,
        hostReserveBytes: input.policy.hostReserveBytes,
      });
      if (!decision.canStart) {
        blockedAutoStarts.push({
          vmId: vm.id,
          vmName: vm.name,
          requiredBytes: vm.memory_bytes,
          allocatedBytes: allocatedMemoryBytes,
          budgetBytes,
          reason: decision.reason ?? "宿主资源不足",
        });
      }
    }
  }

  const pressure = resourcePressure({
    allocatedMemoryBytes,
    budgetBytes,
    freeMemoryBytes: input.freeMemoryBytes,
    hostReserveBytes: input.policy.hostReserveBytes,
  });

  return {
    capturedAt: input.now,
    totalMemoryBytes: input.totalMemoryBytes,
    freeMemoryBytes: input.freeMemoryBytes,
    hostReserveBytes: input.policy.hostReserveBytes,
    softMemoryBudgetBytes: input.policy.softMemoryBudgetBytes,
    effectiveBudgetBytes: budgetBytes,
    allocatedMemoryBytes,
    remainingBudgetBytes,
    pressure,
    runningVmCount: input.vms.filter((vm) => vm.power_state === "running").length,
    suspendedVmCount: input.vms.filter((vm) => vm.power_state === "suspended").length,
    totalVmCount: input.vms.length,
    waitingResourceTaskCount: input.tasks.filter((task) => task.status === "waiting_resources")
      .length,
    waitingVmTaskCount: input.tasks.filter((task) => task.status === "waiting_vm").length,
    queuedTaskCount: input.tasks.filter((task) => task.status === "queued").length,
    blockedAutoStarts,
    autoStartPolicy: input.policy.autoStartPolicy,
    idleSuspendEnabled: input.policy.idleSuspendEnabled,
    idleSuspendTimeoutMs: input.policy.idleSuspendTimeoutMs,
    allocations,
  };
}

export interface AutoStartDecision {
  canStart: boolean;
  reason: string | null;
}

export function autoStartDecision(input: {
  requiredBytes: number;
  allocatedBytes: number;
  budgetBytes: number;
  freeMemoryBytes: number;
  hostReserveBytes: number;
}): AutoStartDecision {
  const remaining = input.budgetBytes - input.allocatedBytes;
  if (input.requiredBytes > remaining) {
    return {
      canStart: false,
      reason: `Soft Memory Budget 不足：需要 ${formatBytes(input.requiredBytes)}，预算剩余 ${formatBytes(
        Math.max(0, remaining),
      )}`,
    };
  }
  const hostAvailable = input.freeMemoryBytes - input.hostReserveBytes;
  if (input.freeMemoryBytes > 0 && input.requiredBytes > hostAvailable) {
    return {
      canStart: false,
      reason: `宿主可用内存低于 Host Reserve 要求：可用 ${formatBytes(
        Math.max(0, hostAvailable),
      )}，需要 ${formatBytes(input.requiredBytes)}`,
    };
  }
  return { canStart: true, reason: null };
}

function resourcePressure(input: {
  allocatedMemoryBytes: number;
  budgetBytes: number;
  freeMemoryBytes: number;
  hostReserveBytes: number;
}): ResourcePressure {
  if (input.budgetBytes > 0) {
    const ratio = input.allocatedMemoryBytes / input.budgetBytes;
    if (ratio >= 0.9) return "critical";
    if (ratio >= 0.75) return "warning";
  }
  if (input.freeMemoryBytes > 0 && input.freeMemoryBytes <= input.hostReserveBytes) {
    return "critical";
  }
  if (
    input.freeMemoryBytes > 0 &&
    input.freeMemoryBytes <= input.hostReserveBytes + 512 * 1024 * 1024
  ) {
    return "warning";
  }
  return "ok";
}

export interface IdleSuspendDecision {
  eligible: boolean;
  eligibleAt: string;
  blockers: string[];
}

export function idleSuspendDecision(input: {
  now: Date;
  idleSince: Date;
  policy: ResourcePolicy;
  blockers: readonly string[];
}): IdleSuspendDecision {
  const eligibleAt = new Date(input.idleSince.getTime() + input.policy.idleSuspendTimeoutMs);
  return {
    eligible:
      input.policy.idleSuspendEnabled &&
      input.blockers.length === 0 &&
      input.now.getTime() >= eligibleAt.getTime(),
    eligibleAt: eligibleAt.toISOString(),
    blockers: [...input.blockers],
  };
}

export function isWorkerAttached(status: string): boolean {
  return status !== "archived" && status !== "failed";
}

export function isSuspendBlockingWorkerStatus(status: string): boolean {
  return (SUSPEND_BLOCKING_WORKER_STATUSES as readonly string[]).includes(status);
}

export function maxIsoTimestamp(values: readonly (string | null | undefined)[]): string | null {
  let winner: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (winner === null || value > winner) winner = value;
  }
  return winner;
}

function countByVm<T extends { vm_id: string; status: string }>(
  rows: readonly T[],
  predicate: (row: T) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    counts.set(row.vm_id, (counts.get(row.vm_id) ?? 0) + 1);
  }
  return counts;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Math.round(gib * 10) / 10} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}
