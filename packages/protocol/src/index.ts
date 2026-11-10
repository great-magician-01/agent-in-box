/**
 * Wire contracts shared by the control plane, web UI, desktop shell and workers.
 * These types describe serialized data only; business rules live in @agent-in-box/domain.
 */

export const PROTOCOL_VERSION = "0.1.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type Id = string;
export type IsoTimestamp = string;

export type OsFamily = "linux" | "windows";

export type ImageStatus = "not_downloaded" | "downloading" | "verifying" | "available" | "failed";

export type VmPowerState = "stopped" | "starting" | "running" | "stopping" | "suspended" | "error";

export type GuestHealthState = "unknown" | "starting" | "healthy" | "degraded" | "unreachable";

export type TaskStatus =
  | "created"
  | "waiting_resources"
  | "waiting_vm"
  | "queued"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkerStatus =
  "starting" | "running" | "idle" | "archiving" | "archived" | "restoring" | "failed";

export type ConversationKind = "router" | "project";

export interface ImageRecord {
  id: Id;
  name: string;
  osFamily: OsFamily;
  osVersion: string;
  architecture: string;
  version: string;
  status: ImageStatus;
  sizeBytes: number;
  checksum: string;
  localPath: string | null;
  createdAt: IsoTimestamp;
  verifiedAt: IsoTimestamp | null;
}

export interface VmInstanceRecord {
  id: Id;
  name: string;
  imageId: Id;
  osFamily: OsFamily;
  cpuCount: number;
  memoryBytes: number;
  diskBytes: number;
  storageRoot: string;
  powerState: VmPowerState;
  guestHealth: GuestHealthState;
  createdAt: IsoTimestamp;
  lastStartedAt: IsoTimestamp | null;
}

export interface ProjectRecord {
  id: Id;
  name: string;
  description: string;
  defaultVmBindingId: Id | null;
  createdAt: IsoTimestamp;
  archivedAt: IsoTimestamp | null;
}

export interface ProjectVmBindingRecord {
  id: Id;
  projectId: Id;
  vmId: Id;
  guestWorkspacePath: string;
  isPrimary: boolean;
  createdAt: IsoTimestamp;
}

export interface TaskRecord {
  id: Id;
  projectId: Id;
  vmId: Id;
  originConversationId: Id;
  assignedWorkerId: Id | null;
  parentTaskId: Id | null;
  objective: string;
  status: TaskStatus;
  priority: number;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  latestSummary: string | null;
  errorCode: string | null;
}

export interface WorkerRecord {
  id: Id;
  projectId: Id;
  vmId: Id;
  conversationId: Id;
  engineType: string;
  engineVersion: string;
  status: WorkerStatus;
  currentTaskId: Id | null;
  capabilitySet: string[];
  createdAt: IsoTimestamp;
  lastActiveAt: IsoTimestamp;
  archivedAt: IsoTimestamp | null;
}

export interface ConversationRecord {
  id: Id;
  kind: ConversationKind;
  projectId: Id | null;
  title: string;
  createdAt: IsoTimestamp;
  lastMessageAt: IsoTimestamp;
}

export interface DomainEventPayloads {
  "task.created": { task: TaskRecord };
  "task.status_changed": { taskId: Id; from: TaskStatus; to: TaskStatus };
  "worker.archived": { workerId: Id; summaryRef: string | null };
  "worker.resumed": { workerId: Id; restoreMode: "native" | "summary" };
  "vm.power_changed": { vmId: Id; from: VmPowerState; to: VmPowerState };
  "bot.connected": { platform: "feishu" | "qq" };
  "bot.disconnected": { platform: "feishu" | "qq"; reason: string };
}

export type DomainEventType = keyof DomainEventPayloads;

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: number;
  type: T;
  occurredAt: IsoTimestamp;
  protocolVersion: ProtocolVersion;
  projectId?: Id;
  taskId?: Id;
  workerId?: Id;
  vmId?: Id;
  payload: DomainEventPayloads[T];
}

export interface HealthResponse {
  status: "ok";
  service: "control-plane";
  protocolVersion: ProtocolVersion;
  startedAt: IsoTimestamp;
  now: IsoTimestamp;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    [
      "created",
      "waiting_resources",
      "waiting_vm",
      "queued",
      "running",
      "waiting_approval",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ].includes(value)
  );
}
