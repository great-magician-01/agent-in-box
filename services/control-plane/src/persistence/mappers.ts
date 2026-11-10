import type { Selectable } from "kysely";
import type {
  ConversationRecord,
  GuestHealthState,
  ImageRecord,
  OsFamily,
  ProjectRecord,
  ProjectVmBindingRecord,
  TaskRecord,
  VmInstanceRecord,
  VmPowerState,
  WorkerRecord,
} from "@agent-in-box/protocol";
import { isTaskStatus, isVmPowerState, isWorkerStatus, OS_FAMILIES } from "@agent-in-box/protocol";
import type {
  ConversationsTable,
  ImagesTable,
  ProjectVmBindingsTable,
  ProjectsTable,
  TasksTable,
  VmInstancesTable,
  WorkersTable,
} from "./schema";

function asOsFamily(value: string): OsFamily {
  if ((OS_FAMILIES as readonly string[]).includes(value)) {
    return value as OsFamily;
  }
  throw new Error(`Invalid os_family in database: ${value}`);
}

function asGuestHealth(value: string): GuestHealthState {
  return value as GuestHealthState;
}

function asVmPowerState(value: string): VmPowerState {
  if (isVmPowerState(value)) {
    return value;
  }
  throw new Error(`Invalid power_state in database: ${value}`);
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function toImageRecord(row: Selectable<ImagesTable>): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    osFamily: asOsFamily(row.os_family),
    osVersion: row.os_version,
    architecture: row.architecture,
    version: row.version,
    status: row.status as ImageRecord["status"],
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    localPath: row.local_path,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

export function toVmInstanceRecord(row: Selectable<VmInstancesTable>): VmInstanceRecord {
  return {
    id: row.id,
    name: row.name,
    imageId: row.image_id,
    osFamily: asOsFamily(row.os_family),
    cpuCount: row.cpu_count,
    memoryBytes: row.memory_bytes,
    diskBytes: row.disk_bytes,
    storageRoot: row.storage_root,
    powerState: asVmPowerState(row.power_state),
    guestHealth: asGuestHealth(row.guest_health),
    createdAt: row.created_at,
    lastStartedAt: row.last_started_at,
  };
}

export function toProjectRecord(row: Selectable<ProjectsTable>): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultVmBindingId: row.default_vm_binding_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export function toProjectVmBindingRecord(
  row: Selectable<ProjectVmBindingsTable>,
): ProjectVmBindingRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    vmId: row.vm_id,
    guestWorkspacePath: row.guest_workspace_path,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
  };
}

export function toConversationRecord(row: Selectable<ConversationsTable>): ConversationRecord {
  return {
    id: row.id,
    kind: row.kind as ConversationRecord["kind"],
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
  };
}

export function toTaskRecord(row: Selectable<TasksTable>): TaskRecord {
  if (!isTaskStatus(row.status)) {
    throw new Error(`Invalid task status in database: ${row.status}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    vmId: row.vm_id,
    originConversationId: row.origin_conversation_id,
    assignedWorkerId: row.assigned_worker_id,
    parentTaskId: row.parent_task_id,
    objective: row.objective,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latestSummary: row.latest_summary,
    errorCode: row.error_code,
  };
}

export function toWorkerRecord(row: Selectable<WorkersTable>): WorkerRecord {
  if (!isWorkerStatus(row.status)) {
    throw new Error(`Invalid worker status in database: ${row.status}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    vmId: row.vm_id,
    conversationId: row.conversation_id,
    engineType: row.engine_type,
    engineVersion: row.engine_version,
    status: row.status,
    currentTaskId: row.current_task_id,
    capabilitySet: parseCapabilities(row.capability_set),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at,
  };
}
