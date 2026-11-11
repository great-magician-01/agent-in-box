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
  waiting_vm: ["waiting_resources", "queued", "cancelled", "blocked", "failed"],
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
export function isWindowsGuestPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

/**
 * Accepts both POSIX and Windows drive-absolute guest paths. UNC paths, device
 * paths, alternate data streams and parent segments are rejected so the same
 * value can be used by policy checks, workspace backups and the Guest Agent.
 */
export function isSafeAbsoluteGuestPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized.includes("\0") ||
    hasParentSegment(normalized)
  ) {
    return false;
  }
  if (normalized.startsWith("/")) {
    return !normalized.startsWith("//");
  }
  if (!isWindowsGuestPath(normalized)) {
    return false;
  }
  // Reject C:\path:stream and device namespaces after the drive prefix.
  return !normalized.slice(2).includes(":");
}

export function isGuestVolumeRoot(value: string): boolean {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return normalized === "/" || normalized === "" || /^[A-Za-z]:$/.test(normalized);
}

export function normalizeGuestWorkspacePath(value: string): string {
  const normalized = value.trim();
  if (!isSafeAbsoluteGuestPath(normalized) || isGuestVolumeRoot(normalized)) {
    throw new Error(
      "Guest workspace must be an absolute POSIX or Windows drive path without '..' or a filesystem root",
    );
  }
  if (normalized.startsWith("/")) {
    return normalized.replace(/\/+$/, "") || "/";
  }
  const drive = normalized.slice(0, 2).toUpperCase();
  const relative = normalized.slice(2).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return `${drive}\\${relative.replace(/\//g, "\\")}`;
}

function normalizeGuestPathForCompare(value: string): { normalized: string; windows: boolean } {
  const windows = isWindowsGuestPath(value);
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || /^[A-Za-z]:$/.test(normalized)) normalized = `${normalized}/`;
  return { normalized: windows ? normalized.toLowerCase() : normalized, windows };
}

export function guestPathsEqual(left: string, right: string): boolean {
  if (!isSafeAbsoluteGuestPath(left) || !isSafeAbsoluteGuestPath(right)) return false;
  const a = normalizeGuestPathForCompare(left);
  const b = normalizeGuestPathForCompare(right);
  return a.windows === b.windows && a.normalized === b.normalized;
}

/**
 * Case-insensitive containment for Windows paths and case-sensitive
 * containment for POSIX paths. Mixed path families never match.
 */
export function guestPathEqualsOrWithin(candidate: string, root: string): boolean {
  if (!isSafeAbsoluteGuestPath(candidate) || !isSafeAbsoluteGuestPath(root)) {
    return false;
  }
  const a = normalizeGuestPathForCompare(candidate);
  const b = normalizeGuestPathForCompare(root);
  if (a.windows !== b.windows) return false;
  return (
    a.normalized === b.normalized || a.normalized.startsWith(`${b.normalized.replace(/\/$/, "")}/`)
  );
}
