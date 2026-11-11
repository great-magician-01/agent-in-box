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
export const ACTIVE_TASK_STATUSES = [
  "created",
  "waiting_resources",
  "waiting_vm",
  "queued",
  "running",
  "waiting_approval",
  "blocked",
] as const satisfies readonly TaskStatus[];

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

export interface ProjectWorkspaceConfig {
  defaultGuestWorkspacePath: string;
}

export interface ProjectRecord {
  id: Id;
  name: string;
  description: string;
  defaultVmBindingId: Id | null;
  workspaceConfig: ProjectWorkspaceConfig;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
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
  attemptCount: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  latestSummary: string | null;
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
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
  agentSessionRef: string | null;
  sessionVersion: string | null;
  lastHeartbeatAt: IsoTimestamp | null;
  archiveSummary: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  providerId: string | null;
  modelId: string | null;
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
  "task.priority_changed": { taskId: Id; from: number; to: number };
  "project.changed": { projectId: Id; action: string };
  "worker.archived": {
    workerId: Id;
    summaryRef: string | null;
    archiveId?: Id;
    source?: WorkerArchiveSource;
  };
  "worker.resumed": {
    workerId: Id;
    restoreMode: "native" | "summary";
    archiveId?: Id;
    notice?: string | null;
  };
  "router.status_changed": {
    conversationId: Id;
    status: RouterStatus;
    error?: string | null;
  };
  "router.message": {
    conversationId: Id;
    messageId: Id;
    role: "user" | "assistant";
  };
  "router.tool_call": {
    conversationId: Id;
    toolName: string;
    status: "ok" | "error";
  };
  "vm.power_changed": { vmId: Id; from: VmPowerState; to: VmPowerState };
  "vm.control_changed": {
    vmId: Id;
    from: "idle" | "ai" | "human";
    to: "idle" | "ai" | "human";
    leaseId: Id | null;
  };
  "bot.connected": { platform: "feishu" | "qq" };
  "bot.disconnected": { platform: "feishu" | "qq"; reason: string };
  "bot.account_changed": { accountId: Id; platform: BotPlatform; action: string };
  "bot.ingress_received": {
    accountId: Id;
    platform: BotPlatform;
    eventId: string;
    conversationId: string;
  };
  "bot.ingress_failed": {
    accountId: Id;
    platform: BotPlatform;
    eventId: string;
    error: string;
  };
  "bot.message_sent": { accountId: Id; platform: BotPlatform; conversationId: string };
  "bot.identity_bound": { platform: BotPlatform; platformUserId: string; role: BotIdentityRole };
  "bot.turn_finished": {
    accountId: Id;
    platform: BotPlatform;
    turnId: Id;
    status: BotTurnStatus;
  };
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
  /**
   * Soft memory budget for running VMs. Zero derives the budget from total
   * memory minus the host reserve. Manual starts may exceed the budget.
   */
  softMemoryBudgetBytes: number;
  autoStartPolicy: AutoStartPolicy;
  /** Suspends a running VM after the idle timeout when no task or Worker needs it. */
  idleSuspendEnabled: boolean;
  idleSuspendTimeoutMs: number;
}

export type ResourcePressure = "ok" | "warning" | "critical";

export interface VmResourceAllocation {
  vmId: Id;
  vmName: string;
  powerState: VmPowerState;
  memoryBytes: number;
  activeTaskCount: number;
  queuedTaskCount: number;
  activeWorkerCount: number;
}

export interface ResourceBlockedStart {
  vmId: Id;
  vmName: string;
  requiredBytes: number;
  allocatedBytes: number;
  budgetBytes: number;
  reason: string;
}

/** Host-wide read model rebuilt from the database and live host memory counters. */
export interface ResourceReport {
  capturedAt: IsoTimestamp;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  hostReserveBytes: number;
  softMemoryBudgetBytes: number;
  effectiveBudgetBytes: number;
  allocatedMemoryBytes: number;
  remainingBudgetBytes: number;
  pressure: ResourcePressure;
  runningVmCount: number;
  suspendedVmCount: number;
  totalVmCount: number;
  waitingResourceTaskCount: number;
  waitingVmTaskCount: number;
  queuedTaskCount: number;
  blockedAutoStarts: ResourceBlockedStart[];
  autoStartPolicy: AutoStartPolicy;
  idleSuspendEnabled: boolean;
  idleSuspendTimeoutMs: number;
  allocations: VmResourceAllocation[];
}

export interface ResourceReconcileResult {
  report: ResourceReport;
  startedVmIds: Id[];
  resumedVmIds: Id[];
  suspendedVmIds: Id[];
  waitingTaskIds: Id[];
}

export interface SecuritySettings {
  requireApprovalForSensitiveActions: boolean;
}

/**
 * Idle Worker archiving. The policy is a host-wide setting; a Worker is only
 * archived after the idle timeout and only when no execution blocker exists.
 */
export interface WorkerLifecyclePolicy {
  autoArchiveEnabled: boolean;
  idleTimeoutMs: number;
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
  workerLifecycle: WorkerLifecyclePolicy;
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
    inbox: string;
    backups: string;
  };
}

/* Phase 12: local-first diagnostics. The report never leaves the machine. */

export type DiagnosticsCheckStatus = "ok" | "warning" | "error";

export interface DiagnosticsCheck {
  name: string;
  status: DiagnosticsCheckStatus;
  detail: string;
}

export interface DiagnosticsLogFile {
  name: string;
  bytes: number;
  truncated: boolean;
}

export interface DiagnosticsMigrationBackup {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: IsoTimestamp;
}

export interface DiagnosticsReport {
  generatedAt: IsoTimestamp;
  warning: string;
  product: {
    version: string;
    protocolVersion: ProtocolVersion;
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
  };
  runtime: {
    platform: string;
    architecture: string;
    release: string;
    hostname: string;
    dataRoot: string;
    dataRootSource: DataRootSource;
    configPath: string;
    databasePath: string;
    logsPath: string;
    loopbackOnly: boolean;
  };
  database: {
    sizeBytes: number;
    walBytes: number;
    shmBytes: number;
    appliedMigrations: string[];
    pendingMigrations: string[];
    quickCheck: string;
    tableCounts: Record<string, number>;
    migrationBackups: DiagnosticsMigrationBackup[];
  };
  storage: {
    freeBytes: number;
    totalBytes: number;
  };
  state: {
    tasksByStatus: Record<string, number>;
    vmsByPower: Record<string, number>;
    workersByStatus: Record<string, number>;
    imagesByStatus: Record<string, number>;
    pendingOutbox: number;
    unreadNotifications: number;
  };
  settings: {
    resourcePolicy: ResourcePolicy;
    security: SecuritySettings;
    workerLifecycle: WorkerLifecyclePolicy;
    preferredModelProvider: string | null;
    credentialsConfigured: boolean;
  };
  logs: {
    files: DiagnosticsLogFile[];
    content: string;
    truncated: boolean;
  };
  checks: DiagnosticsCheck[];
}

export const STORAGE_CATEGORIES = [
  "images",
  "downloads",
  "vms",
  "snapshots",
  "artifacts",
  "archives",
  "inbox",
  "backups",
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
  inbox: string;
  backups: string;
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

export type DesktopUpdateState =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateRollbackView {
  version: string;
  installerPath: string;
  databaseBackupPath: string | null;
  createdAt: IsoTimestamp;
}

export interface DesktopUpdateStatus {
  state: DesktopUpdateState;
  currentVersion: string;
  availableVersion: string | null;
  notes: string | null;
  downloadProgress: number | null;
  error: string | null;
  readyToInstall: boolean;
  rollbackAvailable: DesktopUpdateRollbackView | null;
  checkedAt: IsoTimestamp | null;
}

export interface DesktopPreferences {
  closeBehavior: CloseBehavior;
  launchAtLogin: boolean;
  notificationsEnabled: boolean;
  autoUpdateCheck: boolean;
  updateFeedUrl: string | null;
}

export interface DesktopPreferencesPatch {
  closeBehavior?: CloseBehavior;
  launchAtLogin?: boolean;
  notificationsEnabled?: boolean;
  autoUpdateCheck?: boolean;
  updateFeedUrl?: string | null;
}

export interface DesktopNotificationRequest {
  notificationId: Id;
  title: string;
  body: string;
}

export interface DesktopAppStatus {
  controlPlane: ControlPlaneStatus;
  closeBehavior: CloseBehavior;
  preferences: DesktopPreferences;
  update: DesktopUpdateStatus;
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
    startControlPlane(): Promise<DesktopAppStatus>;
    stopControlPlane(): Promise<DesktopAppStatus>;
    onNavigate(listener: (view: string) => void): () => void;
    quit(): Promise<void>;
    openLogs(): Promise<void>;
  };
  dialog: {
    chooseDirectory(input?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };
  config: {
    getPreferences(): Promise<DesktopPreferences>;
    setPreferences(patch: DesktopPreferencesPatch): Promise<DesktopPreferences>;
  };
  updates: {
    status(): Promise<DesktopUpdateStatus>;
    check(): Promise<DesktopUpdateStatus>;
    download(): Promise<DesktopUpdateStatus>;
    install(): Promise<void>;
    rollback(): Promise<void>;
  };
  notifications: {
    show(request: DesktopNotificationRequest): Promise<boolean>;
    onClick(listener: (notificationId: Id) => void): () => void;
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
  workerHostPort: number;
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
  archivedAt: IsoTimestamp | null;
}

export interface VmTaskReference {
  id: Id;
  objective: string;
  status: TaskStatus;
}

export interface VmQueueItem {
  taskId: Id;
  projectId: Id;
  projectName: string;
  objective: string;
  status: TaskStatus;
  priority: number;
  /** One-based position among runnable queued tasks; null for non-queued states. */
  queuePosition: number | null;
  createdAt: IsoTimestamp;
}

export interface VmActiveWorkerView {
  workerId: Id;
  projectId: Id;
  projectName: string;
  status: WorkerStatus;
  currentTaskId: Id | null;
  lastActiveAt: IsoTimestamp;
}

export interface VmSharingView {
  shared: boolean;
  projectCount: number;
  projects: VmProjectReference[];
  warning: string | null;
}

export interface VmSchedulingView {
  autoStartPolicy: AutoStartPolicy;
  canAutoStart: boolean;
  blockedReason: string | null;
  idleSuspendEnabled: boolean;
  idleSuspendEligibleAt: IsoTimestamp | null;
  idleSuspendBlockers: string[];
  warnings: string[];
}

export interface VmInstanceView {
  vm: VmInstanceRecord;
  runtime: SupervisorVmState | null;
  diskUsageBytes: number;
  boundProjects: VmProjectReference[];
  currentTask: VmTaskReference | null;
  queue: VmQueueItem[];
  activeWorkers: VmActiveWorkerView[];
  sharing: VmSharingView;
  scheduling: VmSchedulingView;
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

/* Phase 9: whole-VM snapshots with explicit shared-VM impact. */
export type VmSnapshotStatus = "creating" | "available" | "failed";

export interface VmSnapshotRecord {
  id: Id;
  vmId: Id;
  tag: string;
  label: string;
  status: VmSnapshotStatus;
  /** Projects bound to the VM when the snapshot was taken. */
  affectedProjects: VmProjectReference[];
  sizeBytes: number | null;
  errorMessage: string | null;
  createdAt: IsoTimestamp;
  restoredAt: IsoTimestamp | null;
}

export interface VmSnapshotProjectImpact extends VmProjectReference {
  activeTaskCount: number;
  lastActivityAt: IsoTimestamp | null;
}

export interface VmSnapshotConflict {
  reason: "vm_not_stopped" | "active_tasks" | "execution_lease";
  message: string;
}

export interface VmSnapshotImpact {
  snapshot: VmSnapshotRecord;
  vmId: Id;
  vmName: string;
  vmPowerState: VmPowerState;
  affectedProjects: VmSnapshotProjectImpact[];
  /** Projects bound now but not when the snapshot was created, or vice versa. */
  bindingSetChanged: boolean;
  activeTaskCount: number;
  requiresConfirmation: boolean;
  warning: string;
  blocked: boolean;
  conflicts: VmSnapshotConflict[];
}

export interface CreateVmSnapshotRequest {
  label?: string;
}

export interface RestoreVmSnapshotRequest {
  confirmSharedImpact?: boolean;
}

/* Phase 9: project-level workspace backups independent from whole-VM snapshots. */
export type ProjectBackupStatus = "creating" | "available" | "failed" | "restoring" | "restored";
export type ProjectBackupBindingStatus = "pending" | "available" | "failed" | "restored";

export interface ProjectBackupBindingRecord {
  id: Id;
  backupId: Id;
  bindingId: Id;
  vmId: Id;
  vmName: string;
  guestWorkspacePath: string;
  sizeBytes: number | null;
  fileCount: number | null;
  sha256: string | null;
  status: ProjectBackupBindingStatus;
  errorMessage: string | null;
}

export interface ProjectBackupArtifactRef {
  artifactId: Id;
  taskId: Id;
  name: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ProjectBackupRecord {
  id: Id;
  projectId: Id;
  label: string;
  status: ProjectBackupStatus;
  bindings: ProjectBackupBindingRecord[];
  artifactSnapshot: ProjectBackupArtifactRef[];
  createdAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  restoredAt: IsoTimestamp | null;
  errorMessage: string | null;
}

export interface ProjectBackupConflict {
  bindingId: Id;
  vmId: Id;
  vmName: string;
  reason:
    | "binding_missing"
    | "workspace_path_changed"
    | "shared_workspace_path"
    | "vm_not_running"
    | "active_tasks"
    | "lease_active"
    | "missing_file";
  message: string;
  affectedProjects: VmProjectReference[];
}

export interface ProjectBackupImpact {
  backup: ProjectBackupRecord;
  blocked: boolean;
  conflicts: ProjectBackupConflict[];
  /** Other projects sharing the affected VMs; their directories are not restored. */
  otherProjects: VmProjectReference[];
  warning: string;
}

export interface CreateProjectBackupRequest {
  label?: string;
}

export interface RestoreProjectBackupRequest {
  confirm: boolean;
}

export interface ProjectBackupVerifyBinding {
  bindingId: Id;
  vmId: Id;
  exists: boolean;
  sha256Matches: boolean;
  sizeMatches: boolean;
}

export interface ProjectBackupVerifyArtifact {
  artifactId: Id;
  relativePath: string;
  exists: boolean;
  sha256Matches: boolean;
  sizeMatches: boolean;
}

export interface ProjectBackupVerifyResult {
  backupId: Id;
  ok: boolean;
  bindings: ProjectBackupVerifyBinding[];
  artifacts: ProjectBackupVerifyArtifact[];
  checkedAt: IsoTimestamp;
}

/* Phase 4: authenticated consoles, guest RPC and unified execution control. */
export type VmControlState = "idle" | "ai" | "human";
export type ExecutionLeaseOwner = "worker" | "human";

export interface ExecutionLeaseView {
  id: Id;
  vmId: Id;
  owner: ExecutionLeaseOwner;
  taskId: Id | null;
  acquiredAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
}

export interface VmControlView {
  vmId: Id;
  state: VmControlState;
  lease: ExecutionLeaseView | null;
}

export interface WorkerLeaseRequest {
  taskId: Id;
  ttlMs?: number;
}

export interface VmConsoleSession {
  vmId: Id;
  /** Relative loopback WebSocket URL containing a short-lived, one-time ticket. */
  webSocketUrl: string;
  lease: ExecutionLeaseView;
  ticketExpiresAt: IsoTimestamp;
}

export interface GuestPoint {
  x: number;
  y: number;
}

export interface GuestInputAction {
  type: "move" | "click" | "drag" | "scroll" | "type_text" | "keypress" | "wait";
  point?: GuestPoint;
  button?: "left" | "middle" | "right";
  count?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  keys?: string[];
  from?: GuestPoint;
  to?: GuestPoint;
  milliseconds?: number;
}

export interface GuestActionRequest {
  leaseId: Id;
  actionId?: string;
  timeoutMs?: number;
  action: GuestInputAction;
}

export interface GuestActionResult {
  actionId: Id;
  ok: boolean;
  error?: string;
  startedAt: IsoTimestamp;
  durationMs: number;
}

export interface GuestAgentCapabilities {
  protocolVersion: string;
  agentVersion?: string;
  displayServer: string;
  screenshot: boolean;
  input: boolean;
  unicodeInput: boolean;
  updateSupported?: boolean;
}

export interface GuestDesktopInfo {
  displayServer: string;
  width: number;
  height: number;
  dpi?: number;
  scaleFactor?: number;
}

export interface GuestVersionHandshake {
  agentVersion: string;
  protocolVersion: string;
  minimumProtocolVersion: string;
  maximumProtocolVersion: string;
  requestedProtocolVersion?: string;
  compatible: boolean;
  compatibilityError?: string;
}

export interface GuestHeartbeat {
  status: "ok" | "degraded";
  protocolVersion: string;
  agentVersion: string;
  now: IsoTimestamp;
  uptimeSeconds: number;
  compatible: boolean;
  desktopAvailable: boolean;
  requestedProtocolVersion?: string;
  compatibilityError?: string;
  displayServer?: string;
  desktopError?: string;
}

export interface GuestScreenshot {
  actionId: Id;
  width: number;
  height: number;
  capturedAt: IsoTimestamp;
  dataBase64: string;
}

export type GuestVerifyCheck =
  | { type: "file"; path: string; sha256?: string; sizeBytes?: number }
  | { type: "process"; name: string };

export interface GuestVerifyRequest {
  actionId?: Id;
  timeoutMs?: number;
  checks: GuestVerifyCheck[];
}

export interface GuestVerifyCheckResult {
  type: "file" | "process";
  ok: boolean;
  errorCode?: string;
  error?: string;
  path?: string;
  sizeBytes?: number;
  sha256?: string;
  modifiedAt?: IsoTimestamp;
  pids?: number[];
}

export interface GuestVerifyResult {
  actionId: Id;
  ok: boolean;
  checks: GuestVerifyCheckResult[];
  error?: string;
}

/* Phase 5: projects, durable per-VM queues and task board projections. */
export interface ProjectActivityRecord {
  id: number;
  projectId: Id;
  type: string;
  payload: unknown;
  createdAt: IsoTimestamp;
}

export interface TaskArtifactRecord {
  id: Id;
  projectId: Id;
  taskId: Id;
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: IsoTimestamp;
  verifiedAt: IsoTimestamp | null;
}

export interface ProjectBindingView {
  binding: ProjectVmBindingRecord;
  vm: VmInstanceRecord;
  sharedProjects: VmProjectReference[];
  sharedActiveTaskCount: number;
  /** Workers of this project currently attached to this VM. */
  activeWorkers: VmActiveWorkerView[];
  /** Active tasks of this project on this VM, including waiting states. */
  queueDepth: number;
}

export interface ProjectView {
  project: ProjectRecord;
  bindings: ProjectBindingView[];
  conversationCount: number;
  activeTaskCount: number;
  activeWorkerCount: number;
}

export interface ProjectDetail extends ProjectView {
  conversations: ConversationRecord[];
  activities: ProjectActivityRecord[];
  artifacts: TaskArtifactRecord[];
}

export interface ProjectCreateRequest {
  name: string;
  description?: string;
  workspaceConfig?: ProjectWorkspaceConfig;
}

export interface ProjectUpdateRequest {
  name?: string;
  description?: string;
  workspaceConfig?: ProjectWorkspaceConfig;
}

export interface ProjectBindingRequest {
  vmId: Id;
  guestWorkspacePath: string;
  isPrimary?: boolean;
}

export interface ProjectBindingUpdateRequest {
  guestWorkspacePath?: string;
  isPrimary?: boolean;
}

export interface TaskCreateRequest {
  projectId: Id;
  vmId: Id;
  originConversationId?: Id;
  objective: string;
  priority?: number;
  parentTaskId?: Id | null;
  dependsOn?: Id[];
}

export interface TaskCreateResult {
  task: TaskRecord;
  created: boolean;
}

export interface TaskBoardItem extends TaskRecord {
  dependencyIds: Id[];
  /** One-based position among runnable queued tasks on this VM; null otherwise. */
  queuePosition: number | null;
  /** Power state of the task's target VM at snapshot time. */
  vmPowerState: VmPowerState;
}

export interface TaskBoardSnapshot {
  tasks: TaskBoardItem[];
  projects: ProjectRecord[];
  vms: VmInstanceRecord[];
  workers: WorkerRecord[];
  /** Filled by the HTTP board route so all pages share one resource read model. */
  resources?: ResourceReport;
  snapshotAt: IsoTimestamp;
  eventCursor: number;
}

export interface TaskDetail {
  task: TaskBoardItem;
  dependencies: TaskRecord[];
  events: TaskEventRecord[];
  artifacts: TaskArtifactRecord[];
}

export interface TaskArtifactInput {
  relativePath: string;
  sha256: string;
  sizeBytes?: number;
  name?: string;
  mediaType?: string;
}

export interface TaskCompletionInput {
  summary: string;
  result?: unknown;
  artifacts?: TaskArtifactInput[];
}

/* Phase 7: Computer Use policy, execution trace, approvals and evidence. */
export const COMPUTER_ACTION_TYPES = [
  "screenshot",
  "click",
  "move",
  "scroll",
  "type_text",
  "keypress",
  "drag",
  "wait",
] as const;
export type ComputerActionType = (typeof COMPUTER_ACTION_TYPES)[number];

export interface CuaNetworkPolicy {
  /** broker_only means the VM may only reach the local Model Broker/CUA Broker. */
  mode: "broker_only" | "unrestricted";
  allowedHosts: string[];
}

export interface CuaFileExchangePolicy {
  enabled: boolean;
  maxBytes: number;
  /** Absolute guest roots that completion file evidence may reference. */
  allowedRoots: string[];
}

export interface CuaCredentialPolicy {
  /** Long-lived provider credentials must never enter the guest when false. */
  allowInGuest: boolean;
}

export interface CuaPolicy {
  maxSteps: number;
  maxDurationMs: number;
  noProgressLimit: number;
  duplicateActionLimit: number;
  approvalTimeoutMs: number;
  approvalActionTypes: ComputerActionType[];
  network: CuaNetworkPolicy;
  fileExchange: CuaFileExchangePolicy;
  credentials: CuaCredentialPolicy;
}

export interface CuaPolicyView {
  projectId: Id;
  policy: CuaPolicy;
  source: "default" | "project";
  updatedAt: IsoTimestamp | null;
}

export type CuaActionStatus =
  "pending_approval" | "executed" | "rejected" | "timed_out" | "cancelled" | "failed" | "blocked";

export interface CuaActionRecord {
  id: Id;
  taskId: Id;
  workerId: Id;
  vmId: Id;
  leaseId: Id;
  type: ComputerActionType;
  action: unknown;
  sourceScreenshotId: Id | null;
  beforeScreenshotId: Id | null;
  afterScreenshotId: Id | null;
  display: {
    width: number;
    height: number;
    dpi: number | null;
    scaleFactor: number | null;
  };
  status: CuaActionStatus;
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  approvalId: Id | null;
  createdAt: IsoTimestamp;
  executedAt: IsoTimestamp | null;
  durationMs: number | null;
}

export type CuaScreenshotKind = "observation" | "before" | "after" | "completion";

export interface CuaScreenshotRecord {
  id: Id;
  taskId: Id;
  workerId: Id;
  vmId: Id;
  kind: CuaScreenshotKind;
  width: number;
  height: number;
  dpi: number | null;
  scaleFactor: number | null;
  sha256: string;
  sizeBytes: number;
  capturedAt: IsoTimestamp;
}

export type CuaApprovalStatus = "pending" | "approved" | "rejected" | "timed_out" | "cancelled";

export interface CuaApprovalRecord {
  id: Id;
  taskId: Id;
  workerId: Id;
  actionId: Id;
  actionType: ComputerActionType;
  contextSummary: string;
  status: CuaApprovalStatus;
  requestedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface CuaApprovalResolveRequest {
  note?: string;
}

export interface TaskExecutionStateView {
  taskId: Id;
  workerId: Id;
  vmId: Id;
  startedAt: IsoTimestamp;
  deadlineAt: IsoTimestamp;
  stepCount: number;
  actionCount: number;
  noProgressStreak: number;
  duplicateStreak: number;
  completionAttempts: number;
  requiresObservation: boolean;
  endedAt: IsoTimestamp | null;
  outcome: "completed" | "blocked" | "failed" | "cancelled" | null;
}

export interface TaskTraceView {
  taskId: Id;
  execution: TaskExecutionStateView | null;
  actions: CuaActionRecord[];
  screenshots: CuaScreenshotRecord[];
  approvals: CuaApprovalRecord[];
}

export type CuaCompletionEvidence =
  | { type: "screenshot"; screenshotId: Id }
  | { type: "file"; path: string; sha256?: string; sizeBytes?: number }
  | { type: "process"; name: string };

export interface CuaCompleteRequest {
  summary: string;
  evidence: CuaCompletionEvidence[];
}

export interface CuaEvidenceResult {
  type: CuaCompletionEvidence["type"];
  verified: boolean;
  detail: string;
  screenshotId?: Id;
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  pids?: number[];
}

export interface CuaCompleteResult {
  taskId: Id;
  completed: boolean;
  evidence: CuaEvidenceResult[];
}

export interface CuaPolicyUpdateRequest {
  maxSteps?: number;
  maxDurationMs?: number;
  noProgressLimit?: number;
  duplicateActionLimit?: number;
  approvalTimeoutMs?: number;
  approvalActionTypes?: ComputerActionType[];
  network?: Partial<CuaNetworkPolicy>;
  fileExchange?: Partial<CuaFileExchangePolicy>;
  credentials?: Partial<CuaCredentialPolicy>;
}

export interface TaskListFilters {
  projectId?: Id;
  vmId?: Id;
  workerId?: Id;
  statuses?: TaskStatus[];
}

/* Phase 6: in-guest Worker sessions and the host-side Model Broker. */
export type WorkerModelApi = "openai-completions" | "anthropic-messages";

export interface WorkerCreateRequest {
  projectId: Id;
  vmId: Id;
  conversationId?: Id;
  providerId?: string;
  model?: string;
  /** Create a fresh Worker from a searchable archive summary instead of reusing a session. */
  restoreArchiveId?: Id;
}

export type WorkerRestoreMode = "native" | "summary";
export type WorkerResumeMode = "auto" | WorkerRestoreMode;

export interface WorkerRuntimeView {
  connected: boolean;
  protocolVersion: string | null;
  engineVersion: string | null;
  sessionVersion: string | null;
  lastError: string | null;
  restoreMode: WorkerRestoreMode | null;
  restoredAt: IsoTimestamp | null;
}

export interface WorkerView {
  worker: WorkerRecord;
  runtime: WorkerRuntimeView;
}

export interface WorkerPromptRequest {
  text: string;
  attachments?: string[];
}

export interface WorkerSteerResult {
  disposition: "queued" | "handled";
  /** Null when a follow-up targets the idle conversation rather than a task. */
  taskId: Id | null;
}

export interface ConversationMessageRecord {
  id: Id;
  conversationId: Id;
  workerId: Id;
  taskId: Id | null;
  role: "user" | "assistant";
  mode: "prompt" | "steer" | "follow_up" | "event";
  content: string;
  createdAt: IsoTimestamp;
}

/* Phase 8: Worker Registry, archives, restore contexts and the local Router. */

export type WorkerArchiveStatus = "available" | "restored" | "superseded";
export type WorkerArchiveSource = "manual" | "auto";

export interface WorkerArchiveArtifactRef {
  taskId: Id;
  name: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkerRestorePoint {
  vmPowerState: VmPowerState;
  guestHealth: GuestHealthState;
  workspacePath: string;
  taskIds: Id[];
  taskCount: number;
  latestTaskStatus: TaskStatus | null;
  lastMessageAt: IsoTimestamp | null;
  capturedAt: IsoTimestamp;
}

export interface WorkerArchiveRecord {
  id: Id;
  workerId: Id;
  projectId: Id;
  vmId: Id;
  conversationId: Id;
  archiveRef: string;
  engineType: string;
  engineVersion: string;
  sessionVersion: string;
  summary: string;
  restorePoint: WorkerRestorePoint | null;
  artifacts: WorkerArchiveArtifactRef[];
  source: WorkerArchiveSource;
  status: WorkerArchiveStatus;
  createdAt: IsoTimestamp;
  restoredAt: IsoTimestamp | null;
}

export interface WorkerArchiveSearchResult {
  items: WorkerArchiveRecord[];
  query: string;
  projectId: Id | null;
  searchedAt: IsoTimestamp;
}

export interface ActiveTaskCard {
  id: Id;
  objective: string;
  status: TaskStatus;
  latestSummary: string | null;
  updatedAt: IsoTimestamp;
}

/** Compact, rebuildable read model for the Router. It never contains screenshots or full history. */
export interface ActiveWorkerCard {
  workerId: Id;
  projectId: Id;
  projectName: string;
  vmId: Id;
  vmName: string;
  vmPowerState: VmPowerState;
  conversationId: Id;
  status: WorkerStatus;
  engineType: string;
  engineVersion: string;
  sessionVersion: string | null;
  capabilities: string[];
  currentTask: ActiveTaskCard | null;
  recentTask: ActiveTaskCard | null;
  queueDepth: number;
  pendingApprovals: number;
  pendingInputs: number;
  lastActiveAt: IsoTimestamp;
  lastHeartbeatAt: IsoTimestamp | null;
}

export interface ActiveRosterView {
  workers: ActiveWorkerCard[];
  snapshotAt: IsoTimestamp;
}

export interface WorkerRelationSuggestion {
  workerId: Id;
  archiveId: Id | null;
  projectId: Id;
  vmId: Id;
  status: WorkerStatus | "archived";
  score: number;
  reasons: string[];
  recommendation: "reuse" | "resume";
  summary: string | null;
}

export interface WorkerRelationView {
  conversationId: Id;
  objective: string;
  projectId: Id | null;
  suggestions: WorkerRelationSuggestion[];
  fallback: "create_new" | "none";
  searchedAt: IsoTimestamp;
}

export interface WorkerArchiveBlockers {
  blocked: boolean;
  reasons: string[];
}

export interface WorkerSummaryView {
  worker: WorkerRecord;
  card: ActiveWorkerCard | null;
  recentTasks: ActiveTaskCard[];
  recentMessages: ConversationMessageRecord[];
  latestArchive: WorkerArchiveRecord | null;
  archiveBlockers: WorkerArchiveBlockers;
}

export interface WorkerResumeRequest {
  mode?: WorkerResumeMode;
}

export interface WorkerResumeEnvironment {
  vmId: Id;
  vmName: string;
  powerState: VmPowerState;
  guestHealth: GuestHealthState;
  workspacePath: string;
  activeTaskIds: Id[];
  recentTasks: ActiveTaskCard[];
  archivedAt: IsoTimestamp | null;
  archivedForMs: number | null;
  /** True when other projects are bound to the same VM. */
  sharedVm: boolean;
  sharedProjects: Array<{
    id: Id;
    name: string;
    archived: boolean;
    activeTaskCount: number;
  }>;
  /** Deterministic environment delta since the archive timestamp. */
  changesSinceArchive: string[];
  capturedAt: IsoTimestamp;
}

export interface WorkerResumeContextRecord {
  id: Id;
  workerId: Id;
  archiveId: Id | null;
  restoreMode: WorkerRestoreMode;
  screenshot: {
    width: number;
    height: number;
    sha256: string;
    capturedAt: IsoTimestamp;
  } | null;
  environment: WorkerResumeEnvironment;
  createdAt: IsoTimestamp;
}

export interface WorkerResumeResult {
  worker: WorkerView;
  restoreMode: WorkerRestoreMode;
  context: WorkerResumeContextRecord;
  /** Human-readable explanation when auto mode fell back to summary restore. */
  notice: string | null;
}

export interface RouterToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type RouterStatus = "idle" | "running" | "failed";

export interface RouterToolCallRecord {
  id: Id;
  conversationId: Id;
  toolName: string;
  args: unknown;
  status: "ok" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: IsoTimestamp;
}

export interface RouterMessageRecord {
  id: Id;
  conversationId: Id;
  role: "user" | "assistant";
  content: string;
  createdAt: IsoTimestamp;
}

export interface RouterView {
  conversationId: Id;
  status: RouterStatus;
  providerId: string | null;
  modelId: string | null;
  engineVersion: string | null;
  sessionVersion: string | null;
  lastError: string | null;
  lastActiveAt: IsoTimestamp;
  tools: RouterToolDefinition[];
  messageCount: number;
}

export interface RouterSendRequest {
  text: string;
}

export interface RouterSendResult {
  conversationId: Id;
  status: RouterStatus;
  message: RouterMessageRecord;
}

/* Phase 10: local Feishu and QQ connectors. */

export const BOT_PLATFORMS = ["feishu", "qq"] as const;
export type BotPlatform = (typeof BOT_PLATFORMS)[number];

/** `disabled` means the account is configured but not connected by policy. */
export type BotRuntimeState = "disabled" | "disconnected" | "connecting" | "connected" | "degraded";
export type BotIdentityRole = "admin" | "member";
export type BotChatKind = "p2p" | "group";
export type BotIngressState = "pending" | "processing" | "processed" | "failed";
export type BotOutboundState = "pending" | "sending" | "sent" | "failed";
export type BotTurnStatus = "running" | "completed" | "failed";

export interface BotAccountConfig {
  /** Feishu Open API base; defaults to https://open.feishu.cn. */
  domain?: string;
  /** QQ Bot API base; defaults to https://api.bot.qq.com. */
  apiBase?: string;
  /** QQ token base; defaults to https://bots.qq.com for production. */
  tokenBaseUrl?: string;
  /** Bot's own Open ID, used to require an explicit group mention on Feishu. */
  botUserId?: string;
  /** QQ gateway intents; defaults to GROUP_AND_C2C_EVENT. */
  intents?: number;
}

export interface BotAccountRecord {
  id: Id;
  platform: BotPlatform;
  name: string;
  enabled: boolean;
  appId: string;
  credentialProviderId: string;
  config: BotAccountConfig;
  deviceId: Id | null;
  state: BotRuntimeState;
  lastConnectedAt: IsoTimestamp | null;
  lastError: string | null;
  lastEventAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface BotAccountView extends BotAccountRecord {
  connected: boolean;
  ingressPending: number;
  outboundPending: number;
  outboundFailed: number;
}

export interface BotIdentityRecord {
  id: Id;
  platform: BotPlatform;
  platformUserId: string;
  displayName: string;
  role: BotIdentityRole;
  bound: boolean;
  createdAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
}

export interface BotChatRecord {
  id: Id;
  platform: BotPlatform;
  conversationId: string;
  kind: BotChatKind;
  title: string;
  allowed: boolean;
  projectId: Id | null;
  lastMessageId: string | null;
  createdAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
}

export interface BotTurnRecord {
  id: Id;
  accountId: Id;
  platform: BotPlatform;
  platformConversationId: string;
  localConversationId: Id;
  userText: string;
  status: BotTurnStatus;
  assistantText: string | null;
  errorMessage: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
}

export interface BotEventView {
  dedupKey: string;
  accountId: Id;
  platform: BotPlatform;
  eventId: string;
  conversationId: string;
  text: string;
  state: BotIngressState;
  attempts: number;
  lastError: string | null;
  receivedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface BotPlatformCapability {
  platform: BotPlatform;
  label: string;
  longConnection: boolean;
  textTasks: boolean;
  progress: boolean;
  approvals: boolean;
  groupChat: boolean;
  attachments: boolean;
  notes: string[];
}

export interface BotOverview {
  deviceId: Id;
  deviceName: string;
  activeDeviceId: Id | null;
  thisDeviceActive: boolean;
  computerOnline: boolean;
  startedAt: IsoTimestamp;
  accounts: BotAccountView[];
  identities: BotIdentityRecord[];
  chats: BotChatRecord[];
  recentTurns: BotTurnRecord[];
  recentEvents: BotEventView[];
  pendingIngress: number;
  failedIngress: number;
  pendingOutbound: number;
  failedOutbound: number;
  platforms: BotPlatformCapability[];
}

export interface BotAccountCreateRequest {
  platform: BotPlatform;
  name?: string;
  appId: string;
  credentialProviderId?: string;
  /** Transient validation secret; never persisted or logged by the control plane. */
  secret?: string;
  config?: BotAccountConfig;
  enabled?: boolean;
}

export interface BotAccountUpdateRequest {
  name?: string;
  appId?: string;
  credentialProviderId?: string;
  secret?: string;
  config?: BotAccountConfig;
  enabled?: boolean;
}

export interface BotAccountTestRequest {
  /** Transient validation secret; falls back to the configured credential provider. */
  secret?: string;
}

export interface BotAccountTestResult {
  ok: boolean;
  accountId: Id;
  state: BotRuntimeState;
  lastError: string | null;
  checkedAt: IsoTimestamp;
}

export interface BotIdentityUpsertRequest {
  platformUserId: string;
  displayName?: string;
  role?: BotIdentityRole;
  bound?: boolean;
}

export interface BotChatUpsertRequest {
  platform: BotPlatform;
  conversationId: string;
  kind: BotChatKind;
  title?: string;
  allowed?: boolean;
  projectId?: Id | null;
}

export interface BotAccessCodeRequest {
  role?: BotIdentityRole;
  expiresInMs?: number;
}

export interface BotAccessCodeView {
  code: string;
  role: BotIdentityRole;
  expiresAt: IsoTimestamp;
}

export interface BotDeviceUpdateRequest {
  active: boolean;
}

export interface BotOutboundTestRequest {
  accountId: Id;
  conversationId: string;
  text: string;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface ModelProviderView {
  id: string;
  baseUrl: string;
  api: WorkerModelApi;
  credentialProviderId: string;
  models: ModelDefinition[];
  enabled: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ModelProviderUpsert {
  baseUrl: string;
  api: WorkerModelApi;
  credentialProviderId: string;
  models: ModelDefinition[];
  enabled?: boolean;
}

export interface ModelRequestUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

export interface ModelRequestRecord {
  id: Id;
  providerId: string;
  model: string;
  workerId: Id;
  taskId: Id | null;
  status: "started" | "completed" | "failed" | "cancelled";
  upstreamStatus: number | null;
  attempts: number;
  durationMs: number | null;
  usage: ModelRequestUsage | null;
  errorCode: string | null;
  createdAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
}

export type TaskStreamState = "live" | "reconnecting";

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === "string" && (WORKER_STATUSES as readonly string[]).includes(value);
}

export function isVmPowerState(value: unknown): value is VmPowerState {
  return typeof value === "string" && (VM_POWER_STATES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------- */
/* Phase 11: local browser authentication, notification center and inbox.     */
/* ------------------------------------------------------------------------- */

export type LocalAuthState = "authenticated" | "anonymous";

export interface LocalAuthUser {
  id: Id;
  displayName: string;
  role: LocalUserRole;
}

export interface LocalAuthSessionView {
  state: LocalAuthState;
  user: LocalAuthUser | null;
  csrfToken: string | null;
  expiresAt: IsoTimestamp | null;
  /** Absolute path of the local access-key file shown on the unlock screen. */
  accessKeyPath: string;
  /** Only true when the desktop shell exposes its trusted-session bridge. */
  desktopShell: boolean;
}

export interface LocalAuthLoginRequest {
  accessKey: string;
  label?: string;
}

export interface LocalAuthRotateResult {
  accessKeyPath: string;
  rotatedAt: IsoTimestamp;
  revokedSessions: number;
}

export const NOTIFICATION_KINDS = [
  "task",
  "approval",
  "worker",
  "vm",
  "resource",
  "router",
  "bot",
  "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["info", "success", "warning", "danger"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface NotificationRecord {
  id: Id;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  projectId: Id | null;
  taskId: Id | null;
  vmId: Id | null;
  workerId: Id | null;
  createdAt: IsoTimestamp;
  readAt: IsoTimestamp | null;
  dismissedAt: IsoTimestamp | null;
}

export interface NotificationCenterView {
  items: NotificationRecord[];
  unreadCount: number;
  snapshotAt: IsoTimestamp;
}

export interface InboxFileRecord {
  id: Id;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  projectId: Id | null;
  createdAt: IsoTimestamp;
}

export interface InboxFileListResponse {
  items: InboxFileRecord[];
}
