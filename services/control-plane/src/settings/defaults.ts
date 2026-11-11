import type {
  ResourcePolicy,
  SecuritySettings,
  WorkerLifecyclePolicy,
} from "@agent-in-box/protocol";

export const GIB = 1024 * 1024 * 1024;

export const MIN_HOST_RESERVE_BYTES = 512 * 1024 * 1024;
export const MIN_SOFT_MEMORY_BUDGET_BYTES = GIB;
export const MIN_VM_IDLE_SUSPEND_TIMEOUT_MS = 5 * 60_000;
export const MAX_VM_IDLE_SUSPEND_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_VM_IDLE_SUSPEND_TIMEOUT_MS = 60 * 60_000;

export function defaultResourcePolicy(totalMemoryBytes: number): ResourcePolicy {
  const quarter = Math.floor(totalMemoryBytes / 4);
  const reserve = Math.min(4 * GIB, Math.max(GIB, quarter));
  return {
    hostReserveBytes: totalMemoryBytes > 0 ? Math.min(reserve, totalMemoryBytes) : reserve,
    softMemoryBudgetBytes: 0,
    autoStartPolicy: "manual",
    idleSuspendEnabled: false,
    idleSuspendTimeoutMs: DEFAULT_VM_IDLE_SUSPEND_TIMEOUT_MS,
  };
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  requireApprovalForSensitiveActions: true,
};

export const MIN_WORKER_IDLE_TIMEOUT_MS = 60_000;
export const MAX_WORKER_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

export const DEFAULT_WORKER_LIFECYCLE_POLICY: WorkerLifecyclePolicy = {
  autoArchiveEnabled: true,
  idleTimeoutMs: 30 * 60_000,
};
