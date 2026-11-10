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
  ResourcePolicy,
  RuntimeInfo,
  SecuritySettings,
  SettingsView,
  StorageCleanupResult,
  StorageMigrationResult,
  StorageReport,
  StorageValidation,
  VmConsole,
  VmConsoleSession,
  VmControlView,
  ExecutionLeaseView,
  WorkerLeaseRequest,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
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
  updateSettings: (body: { resourcePolicy?: ResourcePolicy; security?: SecuritySettings }) =>
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
  vms: () => apiFetch<VmListResponse>("/api/v1/vms"),
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
