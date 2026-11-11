/**
 * Business rules that are independent of transport and persistence.
 * Keep this package free of NestJS, React, database drivers and OS process access.
 */

import type { ProjectVmBindingRecord, TaskStatus, WorkerStatus } from "@agent-in-box/protocol";

export interface TaskTransitionContext {
  hasVmLease: boolean;
  userApproved: boolean;
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ["waiting_resources", "waiting_vm", "queued", "cancelled"],
  waiting_resources: ["waiting_vm", "queued", "cancelled", "blocked"],
  waiting_vm: ["queued", "cancelled", "blocked", "failed"],
  queued: ["running", "waiting_vm", "cancelled", "blocked"],
  running: ["waiting_approval", "completed", "failed", "cancelled", "blocked"],
  waiting_approval: ["running", "blocked", "cancelled", "failed"],
  blocked: ["created", "waiting_vm", "queued", "cancelled", "failed"],
  completed: [],
  failed: ["created", "waiting_vm", "queued"],
  cancelled: [],
};

const WORKER_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  starting: ["running", "idle", "failed"],
  running: ["idle", "failed"],
  idle: ["running", "archiving", "failed"],
  archiving: ["archived", "idle", "failed"],
  archived: ["restoring", "failed"],
  restoring: ["idle", "failed"],
  failed: ["starting", "archived"],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionWorker(from: WorkerStatus, to: WorkerStatus): boolean {
  return WORKER_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

export interface VmLeaseRecord {
  id: string;
  vmId: string;
  owner: "worker" | "human";
  taskId: string | null;
  acquiredAt: string;
  expiresAt: string;
}

export function isLeaseActive(lease: VmLeaseRecord, now: Date): boolean {
  return new Date(lease.expiresAt).getTime() > now.getTime();
}

/**
 * A project may bind several VMs, and several projects may share one VM.
 * Exactly one binding per project is marked primary when a project has any VM.
 */
export function validateBindings(bindings: readonly ProjectVmBindingRecord[]): string[] {
  const errors: string[] = [];
  const primaryCount = bindings.filter((binding) => binding.isPrimary).length;

  if (bindings.length > 0 && primaryCount !== 1) {
    errors.push(`Expected exactly one primary VM binding, found ${primaryCount}`);
  }

  const seenVmIds = new Set<string>();
  for (const binding of bindings) {
    if (seenVmIds.has(binding.vmId)) {
      errors.push(`Duplicate binding for VM ${binding.vmId}`);
    }
    seenVmIds.add(binding.vmId);
  }

  return errors;
}

export function normalizeQueuePriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.trunc(value)));
}

/** Guest paths are configuration only; they are never host filesystem paths. */
export function normalizeGuestWorkspacePath(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized.includes("\0") ||
    !normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Guest workspace must be an absolute POSIX path without '..'");
  }
  return normalized.replace(/\/+$/, "") || "/";
}
