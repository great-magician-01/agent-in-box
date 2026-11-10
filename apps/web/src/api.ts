import type {
  HealthResponse,
  HostInspectionReport,
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
};
