export type AppView =
  "overview" | "session" | "projects" | "tasks" | "vms" | "archive" | "notifications" | "settings";

export type SettingsSection =
  "models" | "general" | "runtime" | "plugins" | "bots" | "storage" | "security" | "diagnostics";

export interface AppRoute {
  view: AppView;
  workerId: string | null;
  projectId: string | null;
  taskId: string | null;
  settingsSection: SettingsSection;
}

const VIEWS = new Set<AppView>([
  "overview",
  "session",
  "projects",
  "tasks",
  "vms",
  "archive",
  "notifications",
  "settings",
]);

const SETTINGS = new Set<SettingsSection>([
  "models",
  "general",
  "runtime",
  "plugins",
  "bots",
  "storage",
  "security",
  "diagnostics",
]);

export const DEFAULT_ROUTE: AppRoute = {
  view: "session",
  workerId: null,
  projectId: null,
  taskId: null,
  settingsSection: "models",
};

function segment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): AppRoute {
  const parts = (hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/").filter(Boolean);
  const candidate = parts[0] as AppView | undefined;
  const view = candidate && VIEWS.has(candidate) ? candidate : "session";
  const id = segment(parts[1]);
  return {
    view,
    workerId:
      view === "session"
        ? parts[0] === "session" && parts[1] === "worker"
          ? segment(parts[2])
          : null
        : null,
    projectId: view === "projects" ? id : null,
    taskId: view === "tasks" ? id : null,
    settingsSection:
      view === "settings" && id && SETTINGS.has(id as SettingsSection)
        ? (id as SettingsSection)
        : "models",
  };
}

export function routeHash(route: AppRoute): string {
  if (route.view === "session" && route.workerId) {
    return `#/session/worker/${encodeURIComponent(route.workerId)}`;
  }
  if (route.view === "projects" && route.projectId) {
    return `#/projects/${encodeURIComponent(route.projectId)}`;
  }
  if (route.view === "tasks" && route.taskId) {
    return `#/tasks/${encodeURIComponent(route.taskId)}`;
  }
  if (route.view === "settings") {
    return `#/settings/${route.settingsSection}`;
  }
  return `#/${route.view}`;
}

export function routeFor(view: AppView, entityId?: string): AppRoute {
  return {
    ...DEFAULT_ROUTE,
    view,
    workerId: view === "session" ? (entityId ?? null) : null,
    projectId: view === "projects" ? (entityId ?? null) : null,
    taskId: view === "tasks" ? (entityId ?? null) : null,
  };
}
