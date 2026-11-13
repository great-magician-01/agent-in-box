import type { Selectable } from "kysely";
import type {
  ConversationRecord,
  GuestHealthState,
  HumanVerificationRecord,
  ImageRecord,
  OsFamily,
  ProjectActivityRecord,
  ProjectRecord,
  ProjectVmBindingRecord,
  RouterMessageRecord,
  TaskArtifactRecord,
  TaskRecord,
  VmInstanceRecord,
  VmPowerState,
  VmProvisioningState,
  WorkerArchiveRecord,
  WorkerRecord,
} from "@agent-in-box/protocol";
import { isTaskStatus, isVmPowerState, isWorkerStatus, OS_FAMILIES } from "@agent-in-box/protocol";
import type {
  ConversationsTable,
  HumanVerificationsTable,
  ImagesTable,
  ProjectVmBindingsTable,
  ProjectsTable,
  RouterMessagesTable,
  TaskArtifactsTable,
  ProjectActivitiesTable,
  TasksTable,
  VmInstancesTable,
  WorkerArchivesTable,
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

function asProvisioningState(value: string): VmProvisioningState {
  return value === "waiting" || value === "installing" || value === "ready" || value === "failed"
    ? value
    : "none";
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

function parseJson(value: string | null): unknown | null {
  if (value === null || value === "") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
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
    sourceUrl: row.source_url,
    fileName: row.file_name,
    downloadedBytes: row.downloaded_bytes,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: row.updated_at || row.created_at,
    seedLocalPath: row.seed_local_path,
    provisioningProfile: row.provisioning_profile,
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
    provisioning: {
      state: asProvisioningState(row.provisioning_state),
      message: row.provisioning_message,
      startedAt: row.provisioning_started_at,
    },
  };
}

export function toProjectRecord(row: Selectable<ProjectsTable>): ProjectRecord {
  const parsed = parseJson(row.workspace_config_json);
  const workspace =
    parsed !== null && typeof parsed === "object" && "defaultGuestWorkspacePath" in parsed
      ? (parsed as { defaultGuestWorkspacePath?: unknown }).defaultGuestWorkspacePath
      : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultVmBindingId: row.default_vm_binding_id,
    workspaceConfig: {
      defaultGuestWorkspacePath:
        typeof workspace === "string" && workspace ? workspace : "/home/aib-worker/workspace",
    },
    agentConfig: { mcpEnabled: projectAgentConfig(row.agent_config_json).mcpEnabled },
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    archivedAt: row.archived_at,
  };
}

function projectAgentConfig(value: string): { mcpEnabled: boolean } {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { mcpEnabled: false };
  }
  return {
    mcpEnabled: (parsed as { mcpEnabled?: unknown }).mcpEnabled === true,
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
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latestSummary: row.latest_summary,
    result: parseJson(row.result_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export function toTaskArtifactRecord(row: Selectable<TaskArtifactsTable>): TaskArtifactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    name: row.name,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

export function toProjectActivityRecord(
  row: Selectable<ProjectActivitiesTable>,
): ProjectActivityRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
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
    agentSessionRef: row.agent_session_ref,
    sessionVersion: row.session_version,
    lastHeartbeatAt: row.last_heartbeat_at,
    archiveSummary: row.archive_summary,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    providerId: row.provider_id,
    modelId: row.model_id,
  };
}

export function toWorkerArchiveRecord(row: Selectable<WorkerArchivesTable>): WorkerArchiveRecord {
  const restorePoint = parseJson(row.restore_point_json);
  const artifacts = parseJson(row.artifacts_json);
  return {
    id: row.id,
    workerId: row.worker_id,
    projectId: row.project_id,
    vmId: row.vm_id,
    conversationId: row.conversation_id,
    archiveRef: row.archive_ref,
    engineType: row.engine_type,
    engineVersion: row.engine_version,
    sessionVersion: row.session_version,
    summary: row.summary,
    restorePoint:
      restorePoint !== null && typeof restorePoint === "object"
        ? (restorePoint as WorkerArchiveRecord["restorePoint"])
        : null,
    artifacts: Array.isArray(artifacts) ? (artifacts as WorkerArchiveRecord["artifacts"]) : [],
    source: row.source === "auto" ? "auto" : "manual",
    status:
      row.status === "restored" || row.status === "superseded"
        ? row.status
        : ("available" as const),
    createdAt: row.created_at,
    restoredAt: row.restored_at,
  };
}

export function toHumanVerificationRecord(
  row: Selectable<HumanVerificationsTable>,
): HumanVerificationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    vmId: row.vm_id,
    reason: row.reason,
    screenshotId: row.screenshot_id,
    status:
      row.status === "completed" || row.status === "cancelled" ? row.status : ("pending" as const),
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

export function toRouterMessageRecord(row: Selectable<RouterMessagesTable>): RouterMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.created_at,
  };
}
