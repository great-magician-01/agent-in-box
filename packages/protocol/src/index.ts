/**
 * Wire contracts shared by the control plane, web UI, desktop shell and workers.
 * These types describe serialized data only; business rules live in @agent-in-box/domain.
 */

export const PROTOCOL_VERSION = "0.1.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key" as const;

export type Id = string;
export type IsoTimestamp = string;

export type OsFamily = "linux" | "windows";
export const OS_FAMILIES = ["linux", "windows"] as const;

export type ImageStatus =
  "not_downloaded" | "downloading" | "verifying" | "available" | "cancelled" | "failed";

export const VM_POWER_STATES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "suspended",
  "error",
] as const;
export type VmPowerState = (typeof VM_POWER_STATES)[number];

export const GUEST_HEALTH_STATES = [
  "unknown",
  "starting",
  "healthy",
  "degraded",
  "unreachable",
] as const;
export type GuestHealthState = (typeof GUEST_HEALTH_STATES)[number];

export const TASK_STATUSES = [
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
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKER_STATUSES = [
  "starting",
  "running",
  "idle",
  "archiving",
  "archived",
  "restoring",
  "failed",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

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
  sourceUrl: string;
  fileName: string;
  downloadedBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: IsoTimestamp;
  seedLocalPath: string | null;
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

export interface TaskEventRecord {
  id: number;
  taskId: Id;
  type: string;
  payload: unknown;
  createdAt: IsoTimestamp;
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
  eventVersion: 1;
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

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "idempotency_conflict"
  | "lease_conflict"
  | "rate_limited"
  | "internal_error"
  | "unavailable";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export interface PageRequest {
  cursor: string | null;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function normalizePageRequest(input?: {
  cursor?: string | null;
  limit?: number;
}): PageRequest {
  const rawLimit = input?.limit;
  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit)
      ? DEFAULT_PAGE_SIZE
      : Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(rawLimit)));

  return {
    cursor: input?.cursor?.trim() || null,
    limit,
  };
}

/**
 * Guest Agent RPC. The transport is a loopback or host-only channel; the payloads
 * intentionally contain no host paths or credentials.
 */
export const GUEST_PROTOCOL_VERSION = "0.1.0" as const;

export type GuestMethod =
  | "health"
  | "getCapabilities"
  | "captureScreen"
  | "getDesktopState"
  | "executeInput"
  | "transferFileIn"
  | "getProcessHealth";

export interface GuestRpcRequest<T = unknown> {
  id: string;
  method: GuestMethod;
  params: T;
  protocolVersion: string;
}

export interface GuestRpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export type GuestRpcResponse<T = unknown> =
  { id: string; ok: true; result: T } | { id: string; ok: false; error: GuestRpcError };

export interface DisplayInfo {
  displayId: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface ScreenCapture {
  displayId: number;
  width: number;
  height: number;
  scaleFactor: number;
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
  capturedAt: IsoTimestamp;
}

export interface DesktopState {
  displays: DisplayInfo[];
  activeWindowTitle: string | null;
  sessionLocked: boolean;
}

export interface GuestCapabilities {
  protocolVersion: string;
  platform: OsFamily;
  canCaptureScreen: boolean;
  canInjectInput: boolean;
  canTransferFiles: boolean;
}

/**
 * Host-side VM provider contract. Every implementation must enforce the same
 * power/health semantics and must never accept model-generated commands.
 */
export type VirtualizationSupport = "available" | "unavailable" | "unknown";

export interface HostInspection {
  providerId: string;
  platform: string;
  virtualization: VirtualizationSupport;
  details: Record<string, string>;
}

export interface VmCreateSpec {
  name: string;
  imageId: Id;
  osFamily: OsFamily;
  cpuCount: number;
  memoryBytes: number;
  diskBytes: number;
  storageRoot: string;
}

export interface VmRuntimeState {
  vmId: Id;
  powerState: VmPowerState;
  guestHealth: GuestHealthState;
  providerVmId: string | null;
}

export interface VmProvider {
  readonly providerId: string;
  inspectHost(): Promise<HostInspection>;
  createVm(spec: VmCreateSpec): Promise<VmRuntimeState>;
  startVm(vmId: Id): Promise<VmRuntimeState>;
  stopVm(vmId: Id, mode: "graceful" | "force"): Promise<VmRuntimeState>;
  suspendVm(vmId: Id): Promise<VmRuntimeState>;
  resumeVm(vmId: Id): Promise<VmRuntimeState>;
  deleteVm(vmId: Id): Promise<void>;
  createSnapshot(vmId: Id): Promise<{ snapshotId: string }>;
  restoreSnapshot(vmId: Id, snapshotId: string): Promise<VmRuntimeState>;
  getVmState(vmId: Id): Promise<VmRuntimeState>;
  attachConsole(vmId: Id): Promise<{ consoleUrl: string }>;
}

/* ------------------------------------------------------------------------- */
/* Phase 2: host inspection, storage, onboarding and the Electron bridge.     */
/* ------------------------------------------------------------------------- */

export type HostCheckStatus = "ok" | "warning" | "error" | "unknown";

export interface HostCheck {
  id: string;
  status: HostCheckStatus;
  message: string;
  details?: Record<string, string>;
}

export interface HostInspectionReport {
  platform: string;
  release: string;
  architecture: string;
  supported: boolean;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  dataRoot: string;
  freeDiskBytes: number;
  ready: boolean;
  recommendedProvider: "qemu-whpx" | "qemu-kvm" | "hyperv" | null;
  checks: HostCheck[];
  inspectedAt: IsoTimestamp;
}

export type AutoStartPolicy = "manual" | "when_needed";

export interface ResourcePolicy {
  /** Memory the host scheduler must keep available for the operating system. */
  hostReserveBytes: number;
  autoStartPolicy: AutoStartPolicy;
}

export interface SecuritySettings {
  requireApprovalForSensitiveActions: boolean;
}

export type LocalUserRole = "admin";

export interface LocalUserRecord {
  id: Id;
  displayName: string;
  role: LocalUserRole;
  createdAt: IsoTimestamp;
  lastActiveAt: IsoTimestamp;
}

export type DataRootSource = "environment" | "config" | "default";

export interface OnboardingState {
  required: boolean;
  completedAt: IsoTimestamp | null;
  dataRoot: string;
  dataRootSource: DataRootSource;
  /** True when app-config.json points at a root this process has not opened yet. */
  restartRequired: boolean;
  configuredDataRoot: string | null;
  resourcePolicy: ResourcePolicy;
  security: SecuritySettings;
  localUser: LocalUserRecord | null;
  preferredModelProvider: string | null;
  credentialsConfigured: boolean;
}

export interface OnboardingCompleteRequest {
  dataRoot: string;
  resourcePolicy: ResourcePolicy;
  security: SecuritySettings;
  displayName: string;
  preferredModelProvider?: string | null;
  /** Metadata only. The secret itself must live in OS secure storage. */
  credentialsConfigured?: boolean;
}

export interface OnboardingCompleteResult {
  state: OnboardingState;
  restartRequired: boolean;
  storageMigration: StorageMigrationResult | null;
}

export interface SettingsView {
  resourcePolicy: ResourcePolicy;
  security: SecuritySettings;
  dataRoot: string;
  dataRootSource: DataRootSource;
  onboarding: OnboardingState;
}

export interface RuntimeInfo {
  platform: string;
  architecture: string;
  dataRoot: string;
  dataRootSource: DataRootSource;
  configPath: string;
  databasePath: string;
  storage: {
    images: string;
    downloads: string;
    vms: string;
    snapshots: string;
    artifacts: string;
    archives: string;
  };
}

export const STORAGE_CATEGORIES = [
  "images",
  "downloads",
  "vms",
  "snapshots",
  "artifacts",
  "archives",
] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export interface StorageLayoutInfo {
  root: string;
  database: string;
  images: string;
  downloads: string;
  vms: string;
  snapshots: string;
  artifacts: string;
  archives: string;
}

export interface StorageValidation {
  path: string;
  resolvedPath: string;
  exists: boolean;
  directory: boolean;
  writable: boolean;
  freeBytes: number;
  totalBytes: number;
  layout: StorageLayoutInfo;
  warnings: string[];
  errors: string[];
  ok: boolean;
}

export interface StorageCategoryUsage {
  category: StorageCategory;
  path: string;
  bytes: number;
  files: number;
}

export interface StorageLockInfo {
  owner: string;
  pid: number;
  hostname: string;
  acquiredAt: IsoTimestamp;
  operation: string;
}

export interface StoragePendingMigration {
  targetRoot: string;
  startedAt: IsoTimestamp;
  operation: string;
}

export interface StorageReport {
  root: string;
  databasePath: string;
  databaseBytes: number;
  totalBytes: number;
  freeBytes: number;
  categories: StorageCategoryUsage[];
  lock: StorageLockInfo | null;
  pendingMigration: StoragePendingMigration | null;
}

export interface StorageMigrationResult {
  from: string;
  to: string;
  filesCopied: number;
  bytesCopied: number;
  durationMs: number;
  verifiedFiles: number;
  warnings: string[];
  configUpdated: boolean;
  restartRequired: boolean;
  oldDataRetained: true;
}

export interface StorageCleanupResult {
  path: string;
  bytesFreed: number;
  filesDeleted: number;
}

export type CloseBehavior = "keep_running" | "quit";

export type ControlPlaneState =
  "starting" | "running" | "external" | "stopping" | "stopped" | "failed";

export interface ControlPlaneStatus {
  state: ControlPlaneState;
  pid: number | null;
  port: number;
  health: HealthResponse | null;
  message: string | null;
  lastExitCode: number | null;
  restarts: number;
}

export interface DesktopAppStatus {
  controlPlane: ControlPlaneStatus;
  closeBehavior: CloseBehavior;
  configDirectory: string;
  logDirectory: string;
  version: string;
  platform: string;
  arch: string;
}

export interface DesktopCredentialProvider {
  providerId: string;
  updatedAt: IsoTimestamp;
}

export interface DesktopCredentialStatus {
  secureStorageAvailable: boolean;
  storageBackend: string | null;
  message: string | null;
  providers: DesktopCredentialProvider[];
}

export interface CredentialSaveRequest {
  providerId: string;
  secret: string;
}

/**
 * The only API the sandboxed renderer receives. Every method maps to one
 * whitelisted IPC handler; there is no generic invoke or Node access.
 */
export interface DesktopBridge {
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  app: {
    status(): Promise<DesktopAppStatus>;
    onStatus(listener: (status: DesktopAppStatus) => void): () => void;
    restartControlPlane(): Promise<DesktopAppStatus>;
    quit(): Promise<void>;
    openLogs(): Promise<void>;
  };
  dialog: {
    chooseDirectory(input?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };
  config: {
    getCloseBehavior(): Promise<CloseBehavior>;
    setCloseBehavior(value: CloseBehavior): Promise<CloseBehavior>;
  };
  credentials: {
    status(): Promise<DesktopCredentialStatus>;
    save(request: CredentialSaveRequest): Promise<DesktopCredentialStatus>;
    remove(providerId: string): Promise<DesktopCredentialStatus>;
  };
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

/* ------------------------------------------------------------------------- */
/* Phase 3: immutable image catalogs and supervised Linux VM lifecycle.       */
/* ------------------------------------------------------------------------- */

export interface ImageArtifactManifest {
  url: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface ImageManifestEntry extends ImageArtifactManifest {
  id: Id;
  name: string;
  osFamily: OsFamily;
  osVersion: string;
  architecture: "amd64" | "arm64";
  version: string;
  seed?: ImageArtifactManifest;
}

export interface ImageManifest {
  schemaVersion: 1;
  allowedHosts: string[];
  images: ImageManifestEntry[];
}

export interface ImageCatalog {
  source: string;
  allowedHosts: string[];
  items: ImageRecord[];
}

export interface ImageDownloadEvent {
  imageId: Id;
  status: ImageStatus;
  downloadedBytes: number;
  totalBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAt: IsoTimestamp;
}

export interface SupervisorVmState {
  id: Id;
  powerState: VmPowerState;
  pid: number;
  qmpPort: number;
  sshHostPort: number;
  guestHostPort: number;
  consoleUrl: string;
  diskPath: string;
  guestHealth: GuestHealthState;
  lastError: string;
  updatedAt: IsoTimestamp;
}

export interface VmCreateRequest {
  name: string;
  imageId: Id;
  cpuCount: number;
  memoryGb: number;
  diskGb: number;
  /** Optional phase-0 NoCloud artifact. It is never generated from model input. */
  seedImagePath?: string;
}

export interface VmProjectReference {
  id: Id;
  name: string;
  isPrimary: boolean;
}

export interface VmTaskReference {
  id: Id;
  objective: string;
  status: TaskStatus;
}

export interface VmInstanceView {
  vm: VmInstanceRecord;
  runtime: SupervisorVmState | null;
  diskUsageBytes: number;
  boundProjects: VmProjectReference[];
  currentTask: VmTaskReference | null;
}

export interface SupervisorAvailability {
  available: boolean;
  message: string | null;
}

export interface VmListResponse {
  items: VmInstanceView[];
  supervisor: SupervisorAvailability;
}

export interface VmConsole {
  vmId: Id;
  consoleUrl: string;
  message: string;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === "string" && (WORKER_STATUSES as readonly string[]).includes(value);
}

export function isVmPowerState(value: unknown): value is VmPowerState {
  return typeof value === "string" && (VM_POWER_STATES as readonly string[]).includes(value);
}
