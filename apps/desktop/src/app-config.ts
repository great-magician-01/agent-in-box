import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CloseBehavior,
  DesktopPreferences,
  DesktopPreferencesPatch,
  DesktopUpdateRollbackView,
} from "@agent-in-box/protocol";

export interface PendingDesktopUpdate {
  version: string;
  previousVersion: string;
  installerPath: string;
  databaseBackupPath: string | null;
  resourcesBackupPath: string | null;
  startedAt: string;
}

export interface DesktopConfigFile {
  version: number;
  dataRoot?: string;
  onboardingCompletedAt?: string;
  closeBehavior?: CloseBehavior;
  launchAtLogin?: boolean;
  notificationsEnabled?: boolean;
  autoUpdateCheck?: boolean;
  updateFeedUrl?: string | null;
  pendingUpdate?: PendingDesktopUpdate;
  rollback?: DesktopUpdateRollbackView & { resourcesBackupPath: string | null };
  pendingMigration?: {
    targetRoot: string;
    startedAt: string;
    operation: string;
  };
  updatedAt?: string;
}

export interface DesktopPaths {
  configDirectory: string;
  configPath: string;
  credentialsPath: string;
  logDirectory: string;
  electronDataDirectory: string;
}

/**
 * This file is shared verbatim with the control plane. It intentionally holds
 * no secrets; model credentials live in OS secure storage via safeStorage.
 */
export function resolveDesktopPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): DesktopPaths {
  const override = env.AGENT_IN_BOX_CONFIG_DIR?.trim();
  let configDirectory: string;
  if (override) {
    configDirectory = path.resolve(override);
  } else if (platform === "win32") {
    configDirectory = path.join(
      env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming"),
      "AgentInBox",
    );
  } else if (platform === "darwin") {
    configDirectory = path.join(homeDir, "Library", "Application Support", "AgentInBox");
  } else {
    configDirectory = path.join(
      env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config"),
      "agent-in-box",
    );
  }

  return {
    configDirectory,
    configPath: path.join(configDirectory, "app-config.json"),
    credentialsPath: path.join(configDirectory, "credentials.json"),
    logDirectory: path.join(configDirectory, "logs"),
    electronDataDirectory: path.join(configDirectory, "electron"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeUpdateFeedUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") {
      return parsed.toString();
    }
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    ) {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function isPendingUpdate(value: unknown): value is PendingDesktopUpdate {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === "string" &&
    typeof value.previousVersion === "string" &&
    typeof value.installerPath === "string" &&
    (typeof value.databaseBackupPath === "string" || value.databaseBackupPath === null) &&
    (typeof value.resourcesBackupPath === "string" || value.resourcesBackupPath === null) &&
    typeof value.startedAt === "string"
  );
}

function isRollbackConfig(
  value: unknown,
): value is DesktopUpdateRollbackView & { resourcesBackupPath: string | null } {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === "string" &&
    typeof value.installerPath === "string" &&
    (typeof value.databaseBackupPath === "string" || value.databaseBackupPath === null) &&
    (typeof value.resourcesBackupPath === "string" || value.resourcesBackupPath === null) &&
    typeof value.createdAt === "string"
  );
}

export function readDesktopConfig(configPath: string): DesktopConfigFile {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { version: 1 };
    }
    const record = parsed as Record<string, unknown>;
    const config: DesktopConfigFile = {
      version: typeof record.version === "number" ? record.version : 1,
    };
    if (typeof record.dataRoot === "string" && record.dataRoot.trim() !== "") {
      config.dataRoot = path.resolve(record.dataRoot);
    }
    if (typeof record.onboardingCompletedAt === "string") {
      config.onboardingCompletedAt = record.onboardingCompletedAt;
    }
    if (record.closeBehavior === "keep_running" || record.closeBehavior === "quit") {
      config.closeBehavior = record.closeBehavior;
    }
    if (typeof record.launchAtLogin === "boolean") {
      config.launchAtLogin = record.launchAtLogin;
    }
    if (typeof record.notificationsEnabled === "boolean") {
      config.notificationsEnabled = record.notificationsEnabled;
    }
    if (typeof record.autoUpdateCheck === "boolean") {
      config.autoUpdateCheck = record.autoUpdateCheck;
    }
    if (record.updateFeedUrl === null) {
      config.updateFeedUrl = null;
    } else if (typeof record.updateFeedUrl === "string") {
      const normalized = normalizeUpdateFeedUrl(record.updateFeedUrl);
      if (normalized !== null) {
        config.updateFeedUrl = normalized;
      }
    }
    if (isPendingUpdate(record.pendingUpdate)) {
      config.pendingUpdate = record.pendingUpdate;
    }
    if (isRollbackConfig(record.rollback)) {
      config.rollback = record.rollback;
    }
    if (
      typeof record.pendingMigration === "object" &&
      record.pendingMigration !== null &&
      !Array.isArray(record.pendingMigration)
    ) {
      const pending = record.pendingMigration as Record<string, unknown>;
      if (
        typeof pending.targetRoot === "string" &&
        typeof pending.startedAt === "string" &&
        typeof pending.operation === "string"
      ) {
        config.pendingMigration = {
          targetRoot: path.resolve(pending.targetRoot),
          startedAt: pending.startedAt,
          operation: pending.operation,
        };
      }
    }
    if (typeof record.updatedAt === "string") {
      config.updatedAt = record.updatedAt;
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1 };
    }
    throw error;
  }
}

export function writeDesktopConfig(configPath: string, config: DesktopConfigFile): void {
  const directory = path.dirname(path.resolve(configPath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.app-config.${process.pid}.${Date.now()}.tmp`);
  const payload = { ...config, version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM") {
      fs.rmSync(configPath, { force: true });
      fs.renameSync(temporary, configPath);
    } else {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows does not use POSIX modes.
  }
}

export function getCloseBehavior(configPath: string): CloseBehavior {
  return readDesktopConfig(configPath).closeBehavior ?? "keep_running";
}

export function setCloseBehavior(configPath: string, value: CloseBehavior): CloseBehavior {
  if (value !== "keep_running" && value !== "quit") {
    throw new Error("无效的关闭窗口行为");
  }
  const current = readDesktopConfig(configPath);
  writeDesktopConfig(configPath, { ...current, closeBehavior: value });
  return value;
}

export function getDesktopPreferences(configPath: string): DesktopPreferences {
  const config = readDesktopConfig(configPath);
  return {
    closeBehavior: config.closeBehavior ?? "keep_running",
    launchAtLogin: config.launchAtLogin ?? false,
    notificationsEnabled: config.notificationsEnabled ?? true,
    autoUpdateCheck: config.autoUpdateCheck ?? false,
    updateFeedUrl: config.updateFeedUrl ?? null,
  };
}

export function setDesktopPreferences(
  configPath: string,
  patch: DesktopPreferencesPatch,
): DesktopPreferences {
  if (
    patch.closeBehavior !== undefined &&
    patch.closeBehavior !== "keep_running" &&
    patch.closeBehavior !== "quit"
  ) {
    throw new Error("无效的关闭窗口行为");
  }
  if (
    patch.updateFeedUrl !== undefined &&
    patch.updateFeedUrl !== null &&
    normalizeUpdateFeedUrl(patch.updateFeedUrl) === null
  ) {
    throw new Error("更新源必须是 HTTPS 地址（开发测试可使用本机回环 HTTP）");
  }
  for (const key of ["launchAtLogin", "notificationsEnabled", "autoUpdateCheck"] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
      throw new Error(`无效的桌面设置：${key}`);
    }
  }
  const current = readDesktopConfig(configPath);
  const next: DesktopConfigFile = { ...current };
  if (patch.closeBehavior !== undefined) next.closeBehavior = patch.closeBehavior;
  if (patch.launchAtLogin !== undefined) next.launchAtLogin = patch.launchAtLogin;
  if (patch.notificationsEnabled !== undefined) {
    next.notificationsEnabled = patch.notificationsEnabled;
  }
  if (patch.autoUpdateCheck !== undefined) next.autoUpdateCheck = patch.autoUpdateCheck;
  if (patch.updateFeedUrl !== undefined) {
    next.updateFeedUrl =
      patch.updateFeedUrl === null ? null : normalizeUpdateFeedUrl(patch.updateFeedUrl);
  }
  writeDesktopConfig(configPath, next);
  return getDesktopPreferences(configPath);
}

export function readPendingUpdate(configPath: string): PendingDesktopUpdate | null {
  return readDesktopConfig(configPath).pendingUpdate ?? null;
}

export function setPendingUpdate(configPath: string, pending: PendingDesktopUpdate | null): void {
  const current = readDesktopConfig(configPath);
  const next: DesktopConfigFile = { ...current };
  if (pending) {
    next.pendingUpdate = pending;
  } else {
    delete next.pendingUpdate;
  }
  writeDesktopConfig(configPath, next);
}

export function readRollback(
  configPath: string,
): (DesktopUpdateRollbackView & { resourcesBackupPath: string | null }) | null {
  return readDesktopConfig(configPath).rollback ?? null;
}

export function setRollback(
  configPath: string,
  rollback: (DesktopUpdateRollbackView & { resourcesBackupPath: string | null }) | null,
): void {
  const current = readDesktopConfig(configPath);
  const next: DesktopConfigFile = { ...current };
  if (rollback) {
    next.rollback = rollback;
  } else {
    delete next.rollback;
  }
  writeDesktopConfig(configPath, next);
}
