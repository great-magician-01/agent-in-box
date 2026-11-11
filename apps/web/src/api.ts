import type {
  HealthResponse,
  HostInspectionReport,
  ImageCatalog,
  ImageDownloadEvent,
  ImageRecord,
  ImageStatus,
  OnboardingCompleteRequest,
  OnboardingCompleteResult,
  OnboardingState,
  CreateProjectBackupRequest,
  CreateVmSnapshotRequest,
  ProjectBackupImpact,
  ProjectBackupRecord,
  ProjectBackupVerifyResult,
  ResourcePolicy,
  ResourceReconcileResult,
  ResourceReport,
  RestoreProjectBackupRequest,
  RestoreVmSnapshotRequest,
  RuntimeInfo,
  SecuritySettings,
  SettingsView,
  StorageCleanupResult,
  StorageMigrationResult,
  StorageReport,
  StorageValidation,
  ProjectBindingRequest,
  ProjectBindingUpdateRequest,
  ProjectCreateRequest,
  ProjectDetail,
  ProjectUpdateRequest,
  ProjectView,
  ConversationRecord,
  TaskArtifactRecord,
  TaskBoardSnapshot,
  TaskCreateRequest,
  TaskCreateResult,
  TaskDetail,
  TaskListFilters,
  TaskRecord,
  TaskStreamState,
  TaskTraceView,
  CuaApprovalRecord,
  CuaPolicyUpdateRequest,
  CuaPolicyView,
  VmConsole,
  VmConsoleSession,
  VmControlView,
  VmSnapshotImpact,
  VmSnapshotRecord,
  ExecutionLeaseView,
  WorkerLeaseRequest,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  ConversationMessageRecord,
  ModelProviderUpsert,
  ModelProviderView,
  ActiveRosterView,
  RouterMessageRecord,
  RouterSendResult,
  RouterToolCallRecord,
  RouterToolDefinition,
  RouterView,
  WorkerArchiveBlockers,
  WorkerArchiveRecord,
  WorkerArchiveSearchResult,
  WorkerCreateRequest,
  WorkerPromptRequest,
  WorkerRelationView,
  WorkerResumeRequest,
  WorkerResumeResult,
  WorkerSteerResult,
  WorkerSummaryView,
  WorkerView,
} from "@agent-in-box/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const error =
      parsed !== null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "object"
        ? (parsed as { error: { code?: string; message?: string; details?: unknown } }).error
        : null;
    throw new ApiRequestError(
      error?.code ?? `http_${response.status}`,
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      error?.details,
    );
  }
  return (await response.json()) as T;
}

export async function fetchHealth(timeoutMs = 5000): Promise<HealthResponse> {
  const response = await fetch("/api/v1/health", {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new ApiRequestError(
      "unavailable",
      `控制平面返回 HTTP ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as HealthResponse;
}

export const IMAGE_EVENTS_PATH = "/api/v1/images/events";

const IMAGE_STATUS_VALUES = new Set<ImageStatus>([
  "not_downloaded",
  "downloading",
  "verifying",
  "available",
  "cancelled",
  "failed",
]);

function isImageStatus(value: unknown): value is ImageStatus {
  return typeof value === "string" && IMAGE_STATUS_VALUES.has(value as ImageStatus);
}

function parseImageDownloadEvent(raw: string): ImageDownloadEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.imageId !== "string" ||
    !isImageStatus(value.status) ||
    typeof value.downloadedBytes !== "number" ||
    typeof value.totalBytes !== "number"
  ) {
    return null;
  }
  return {
    imageId: value.imageId,
    status: value.status,
    downloadedBytes: value.downloadedBytes,
    totalBytes: value.totalBytes,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null,
    occurredAt: typeof value.occurredAt === "string" ? value.occurredAt : new Date().toISOString(),
  };
}

export type ImageEventStreamState = "live" | "reconnecting";

/**
 * Subscribes to the image download SSE feed. The browser reconnects on its own,
 * so failures are reported once through onStateChange instead of being logged
 * for every retry. Callers must invoke the returned function on unmount.
 */
export function subscribeImageEvents(
  onEvent: (event: ImageDownloadEvent) => void,
  onStateChange?: (state: ImageEventStreamState) => void,
): () => void {
  const source = new EventSource(IMAGE_EVENTS_PATH);
  source.onopen = () => onStateChange?.("live");
  source.onmessage = (message: MessageEvent) => {
    if (typeof message.data !== "string") {
      return;
    }
    const event = parseImageDownloadEvent(message.data);
    if (event) {
      onEvent(event);
    }
  };
  source.onerror = () => onStateChange?.("reconnecting");
  return () => source.close();
}

export const TASK_EVENTS_PATH = "/api/v1/events/ws";

/**
 * WebSocket messages are invalidation hints, not a second task state store.
 * Every open/reconnect triggers a full board snapshot read by the caller.
 */
export function subscribeTaskEvents(
  onInvalidate: () => void,
  onStateChange?: (state: TaskStreamState) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}${TASK_EVENTS_PATH}`);
    socket.onopen = () => {
      onStateChange?.("live");
      onInvalidate();
    };
    socket.onmessage = (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      try {
        const event = JSON.parse(message.data) as { type?: unknown };
        if (event.type === "invalidate") onInvalidate();
      } catch {
        // Invalid hints are ignored; the next reconnect always performs full sync.
      }
    };
    socket.onclose = () => {
      if (closed) return;
      onStateChange?.("reconnecting");
      retryTimer = window.setTimeout(connect, 1000);
    };
    socket.onerror = () => socket?.close();
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  };
}

function taskBoardQuery(filters: TaskListFilters): string {
  const query = new URLSearchParams();
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.vmId) query.set("vmId", filters.vmId);
  if (filters.workerId) query.set("workerId", filters.workerId);
  if (filters.statuses?.length) query.set("status", filters.statuses.join(","));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export const api = {
  health: fetchHealth,
  runtime: () => apiFetch<RuntimeInfo>("/api/v1/runtime"),
  onboarding: () => apiFetch<OnboardingState>("/api/v1/onboarding"),
  completeOnboarding: (body: OnboardingCompleteRequest) =>
    apiFetch<OnboardingCompleteResult>("/api/v1/onboarding/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  settings: () => apiFetch<SettingsView>("/api/v1/settings"),
  updateSettings: (body: {
    resourcePolicy?: ResourcePolicy;
    security?: SecuritySettings;
    workerLifecycle?: { autoArchiveEnabled: boolean; idleTimeoutMs: number };
  }) =>
    apiFetch<SettingsView>("/api/v1/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  hostInspection: (dataRoot?: string) =>
    apiFetch<HostInspectionReport>(
      `/api/v1/host/inspection${dataRoot ? `?dataRoot=${encodeURIComponent(dataRoot)}` : ""}`,
    ),
  storage: () => apiFetch<StorageReport>("/api/v1/storage"),
  validateStorage: (path: string) =>
    apiFetch<StorageValidation>("/api/v1/storage/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  migrateStorage: (targetRoot: string) =>
    apiFetch<StorageMigrationResult>("/api/v1/storage/migrate", {
      method: "POST",
      body: JSON.stringify({ targetRoot }),
    }),
  cleanupDownloads: () =>
    apiFetch<StorageCleanupResult>("/api/v1/storage/cleanup-downloads", {
      method: "POST",
    }),
  projects: (includeArchived = true) =>
    apiFetch<ProjectView[]>(`/api/v1/projects?includeArchived=${includeArchived}`),
  project: (id: string) => apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`),
  createProject: (body: ProjectCreateRequest) =>
    apiFetch<ProjectDetail>("/api/v1/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: ProjectUpdateRequest) =>
    apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  archiveProject: (id: string) =>
    apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    }),
  restoreProject: (id: string) =>
    apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }),
  deleteProject: (id: string) =>
    apiFetch<{ deleted: true; projectId: string }>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  bindProjectVm: (id: string, body: ProjectBindingRequest) =>
    apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}/bindings`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProjectVmBinding: (id: string, bindingId: string, body: ProjectBindingUpdateRequest) =>
    apiFetch<ProjectDetail>(
      `/api/v1/projects/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  unbindProjectVm: (id: string, bindingId: string) =>
    apiFetch<ProjectDetail>(
      `/api/v1/projects/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`,
      { method: "DELETE" },
    ),
  createProjectConversation: (id: string, title: string) =>
    apiFetch<ConversationRecord>(`/api/v1/projects/${encodeURIComponent(id)}/conversations`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  modelProviders: () => apiFetch<ModelProviderView[]>("/api/v1/models/providers"),
  upsertModelProvider: (id: string, body: ModelProviderUpsert) =>
    apiFetch<ModelProviderView>(`/api/v1/models/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  workers: (projectId?: string) =>
    apiFetch<WorkerView[]>(
      `/api/v1/workers${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  createWorker: (body: WorkerCreateRequest) =>
    apiFetch<WorkerView>("/api/v1/workers", { method: "POST", body: JSON.stringify(body) }),
  worker: (id: string) => apiFetch<WorkerView>(`/api/v1/workers/${encodeURIComponent(id)}`),
  workerMessages: (id: string) =>
    apiFetch<ConversationMessageRecord[]>(`/api/v1/workers/${encodeURIComponent(id)}/messages`),
  workerPrompt: (id: string, body: WorkerPromptRequest) =>
    apiFetch<{ taskId: string; worker: WorkerView }>(
      `/api/v1/workers/${encodeURIComponent(id)}/prompt`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  workerSteer: (id: string, body: WorkerPromptRequest) =>
    apiFetch<WorkerSteerResult>(`/api/v1/workers/${encodeURIComponent(id)}/steer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  workerFollowUp: (id: string, body: WorkerPromptRequest) =>
    apiFetch<WorkerSteerResult>(`/api/v1/workers/${encodeURIComponent(id)}/follow-up`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  workerAbort: (id: string, reason?: string) =>
    apiFetch<WorkerView>(`/api/v1/workers/${encodeURIComponent(id)}/abort`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  workerArchive: (id: string) =>
    apiFetch<WorkerView>(`/api/v1/workers/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    }),
  workerResume: (id: string, body: WorkerResumeRequest = {}) =>
    apiFetch<WorkerResumeResult>(`/api/v1/workers/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  workerBlockers: (id: string) =>
    apiFetch<WorkerArchiveBlockers>(`/api/v1/workers/${encodeURIComponent(id)}/blockers`),
  workerArchives: (id: string) =>
    apiFetch<WorkerArchiveRecord[]>(`/api/v1/workers/${encodeURIComponent(id)}/archives`),
  workerSummary: (id: string) =>
    apiFetch<WorkerSummaryView>(`/api/v1/registry/workers/${encodeURIComponent(id)}/summary`),
  activeRoster: (projectId?: string) =>
    apiFetch<ActiveRosterView>(
      `/api/v1/registry/workers${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  searchWorkerArchives: (input: { projectId?: string; query?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.query) query.set("query", input.query);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const encoded = query.toString();
    return apiFetch<WorkerArchiveSearchResult>(
      `/api/v1/registry/archives${encoded ? `?${encoded}` : ""}`,
    );
  },
  findRelatedWorkers: (input: {
    conversationId: string;
    objective: string;
    projectId?: string;
  }) => {
    const query = new URLSearchParams({ conversationId: input.conversationId });
    query.set("objective", input.objective);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<WorkerRelationView>(`/api/v1/registry/find-related?${query.toString()}`);
  },
  router: () => apiFetch<RouterView>("/api/v1/router"),
  routerMessages: (limit = 100) =>
    apiFetch<RouterMessageRecord[]>(`/api/v1/router/messages?limit=${limit}`),
  routerSend: (text: string) =>
    apiFetch<RouterSendResult>("/api/v1/router/messages", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  routerAbort: () => apiFetch<RouterView>("/api/v1/router/abort", { method: "POST" }),
  routerTools: () => apiFetch<RouterToolDefinition[]>("/api/v1/router/tools"),
  routerToolCalls: (limit = 50) =>
    apiFetch<RouterToolCallRecord[]>(`/api/v1/router/tool-calls?limit=${limit}`),
  taskBoard: (filters: TaskListFilters = {}) =>
    apiFetch<TaskBoardSnapshot>(`/api/v1/tasks/board${taskBoardQuery(filters)}`),
  taskDetail: (id: string) => apiFetch<TaskDetail>(`/api/v1/tasks/${encodeURIComponent(id)}`),
  createTask: (body: TaskCreateRequest, idempotencyKey: string) =>
    apiFetch<TaskCreateResult>("/api/v1/tasks", {
      method: "POST",
      headers: { "x-idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    }),
  setTaskPriority: (id: string, priority: number) =>
    apiFetch<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(id)}/priority`, {
      method: "PATCH",
      body: JSON.stringify({ priority }),
    }),
  cancelTask: (id: string, reason?: string) =>
    apiFetch<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  retryTask: (id: string) =>
    apiFetch<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  requeueTask: (id: string) =>
    apiFetch<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(id)}/requeue`, { method: "POST" }),
  verifyTaskArtifact: (taskId: string, artifactId: string) =>
    apiFetch<TaskArtifactRecord>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/verify`,
      { method: "POST" },
    ),
  taskTrace: (taskId: string) =>
    apiFetch<TaskTraceView>(`/api/v1/tasks/${encodeURIComponent(taskId)}/trace`),
  approvals: (taskId?: string) =>
    apiFetch<CuaApprovalRecord[]>(
      `/api/v1/approvals${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`,
    ),
  approveApproval: (id: string, note?: string) =>
    apiFetch<CuaApprovalRecord>(`/api/v1/approvals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
  rejectApproval: (id: string, note?: string) =>
    apiFetch<CuaApprovalRecord>(`/api/v1/approvals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
  projectPolicy: (projectId: string) =>
    apiFetch<CuaPolicyView>(`/api/v1/projects/${encodeURIComponent(projectId)}/policy`),
  updateProjectPolicy: (projectId: string, body: CuaPolicyUpdateRequest) =>
    apiFetch<CuaPolicyView>(`/api/v1/projects/${encodeURIComponent(projectId)}/policy`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  images: () => apiFetch<ImageCatalog>("/api/v1/images"),
  refreshImageManifest: () =>
    apiFetch<ImageCatalog>("/api/v1/images/manifest/refresh", { method: "POST" }),
  downloadImage: (id: string) =>
    apiFetch<ImageRecord>(`/api/v1/images/${encodeURIComponent(id)}/download`, {
      method: "POST",
    }),
  cancelImageDownload: (id: string) =>
    apiFetch<ImageRecord>(`/api/v1/images/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  resources: () => apiFetch<ResourceReport>("/api/v1/resources"),
  reconcileResources: () =>
    apiFetch<ResourceReconcileResult>("/api/v1/resources/reconcile", { method: "POST" }),
  vms: () => apiFetch<VmListResponse>("/api/v1/vms"),
  deleteVm: (id: string) =>
    apiFetch<{ deleted: true; vmId: string }>(`/api/v1/vms/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  vmSnapshots: (id: string) =>
    apiFetch<VmSnapshotRecord[]>(`/api/v1/vms/${encodeURIComponent(id)}/snapshots`),
  createVmSnapshot: (id: string, body: CreateVmSnapshotRequest = {}) =>
    apiFetch<VmSnapshotRecord>(`/api/v1/vms/${encodeURIComponent(id)}/snapshots`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  vmSnapshotImpact: (id: string, snapshotId: string) =>
    apiFetch<VmSnapshotImpact>(
      `/api/v1/vms/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/impact`,
    ),
  restoreVmSnapshot: (id: string, snapshotId: string, body: RestoreVmSnapshotRequest = {}) =>
    apiFetch<VmSnapshotImpact>(
      `/api/v1/vms/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  projectBackups: (projectId: string) =>
    apiFetch<ProjectBackupRecord[]>(`/api/v1/projects/${encodeURIComponent(projectId)}/backups`),
  createProjectBackup: (projectId: string, body: CreateProjectBackupRequest = {}) =>
    apiFetch<ProjectBackupRecord>(`/api/v1/projects/${encodeURIComponent(projectId)}/backups`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  projectBackupImpact: (projectId: string, backupId: string) =>
    apiFetch<ProjectBackupImpact>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}/impact`,
    ),
  restoreProjectBackup: (projectId: string, backupId: string, body: RestoreProjectBackupRequest) =>
    apiFetch<ProjectBackupRecord>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}/restore`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  verifyProjectBackup: (projectId: string, backupId: string) =>
    apiFetch<ProjectBackupVerifyResult>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}/verify`,
      { method: "POST" },
    ),
  deleteProjectBackup: (projectId: string, backupId: string) =>
    apiFetch<{ deleted: true; backupId: string }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(backupId)}`,
      { method: "DELETE" },
    ),
  createVm: (body: VmCreateRequest) =>
    apiFetch<VmInstanceView>("/api/v1/vms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startVm: (id: string) =>
    apiFetch<VmInstanceView>(`/api/v1/vms/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),
  stopVm: (id: string, mode: "graceful" | "force") =>
    apiFetch<VmInstanceView>(`/api/v1/vms/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  suspendVm: (id: string) =>
    apiFetch<VmInstanceView>(`/api/v1/vms/${encodeURIComponent(id)}/suspend`, {
      method: "POST",
    }),
  resumeVm: (id: string) =>
    apiFetch<VmInstanceView>(`/api/v1/vms/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }),
  vmConsole: (id: string) => apiFetch<VmConsole>(`/api/v1/vms/${encodeURIComponent(id)}/console`),
  vmControl: (id: string) =>
    apiFetch<VmControlView>(`/api/v1/vms/${encodeURIComponent(id)}/control`),
  openVmConsole: (id: string) =>
    apiFetch<VmConsoleSession>(`/api/v1/vms/${encodeURIComponent(id)}/console/sessions`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  acquireWorkerLease: (id: string, body: WorkerLeaseRequest) =>
    apiFetch<ExecutionLeaseView>(`/api/v1/vms/${encodeURIComponent(id)}/lease/worker`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  heartbeatVmLease: (id: string, leaseId: string) =>
    apiFetch<ExecutionLeaseView>(`/api/v1/vms/${encodeURIComponent(id)}/lease/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ leaseId }),
    }),
  releaseVmLease: (id: string, leaseId: string) =>
    apiFetch<{ released: boolean }>(`/api/v1/vms/${encodeURIComponent(id)}/lease/release`, {
      method: "POST",
      body: JSON.stringify({ leaseId }),
    }),
};
