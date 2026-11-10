import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StorageLayout } from "./paths";
import { defaultDataRoot } from "./paths";

export const APP_CONFIG_FILENAME = "app-config.json";
export const APP_CONFIG_VERSION = 1;

export type CloseBehavior = "keep_running" | "quit";

/**
 * Small application configuration lives in the OS configuration directory.
 * Large files (images, VMs, snapshots) never do; the data root below is a
 * pointer maintained by Storage Manager and the first-run wizard.
 */
export interface PendingMigrationConfig {
  targetRoot: string;
  startedAt: string;
  operation: string;
}

export interface AppConfigFile {
  version: number;
  dataRoot?: string;
  onboardingCompletedAt?: string;
  closeBehavior?: CloseBehavior;
  pendingMigration?: PendingMigrationConfig;
  updatedAt?: string;
}

export type DataRootSource = "environment" | "config" | "default";

export interface ResolveDataRootOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface ResolvedDataRoot {
  root: string;
  source: DataRootSource;
  configPath: string;
}

export function appConfigDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env.AGENT_IN_BOX_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "AgentInBox");
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "AgentInBox");
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  return path.join(configHome, "agent-in-box");
}

export function appConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(appConfigDirectory(platform, env, homeDir), APP_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readAppConfig(configPath: string): AppConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: APP_CONFIG_VERSION };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid application config JSON: ${configPath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Application config must be a JSON object: ${configPath}`);
  }

  const config: AppConfigFile = {
    version: typeof parsed.version === "number" ? parsed.version : APP_CONFIG_VERSION,
  };

  if (typeof parsed.dataRoot === "string" && parsed.dataRoot.trim() !== "") {
    config.dataRoot = path.resolve(parsed.dataRoot.trim());
  }
  if (typeof parsed.onboardingCompletedAt === "string") {
    config.onboardingCompletedAt = parsed.onboardingCompletedAt;
  }
  if (parsed.closeBehavior === "keep_running" || parsed.closeBehavior === "quit") {
    config.closeBehavior = parsed.closeBehavior;
  }
  if (isRecord(parsed.pendingMigration)) {
    const pending = parsed.pendingMigration;
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
  if (typeof parsed.updatedAt === "string") {
    config.updatedAt = parsed.updatedAt;
  }

  return config;
}

/**
 * Atomic write: a same-directory temporary file is synced and renamed over the
 * target. Secrets are never written here.
 */
export function writeAppConfig(configPath: string, config: AppConfigFile): void {
  const directory = path.dirname(path.resolve(configPath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const payload: AppConfigFile = {
    ...config,
    version: APP_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const temporary = path.join(
    directory,
    `.${APP_CONFIG_FILENAME}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, configPath);
  } catch (error) {
    // Windows can refuse to replace an existing file; remove-and-retry keeps
    // the operation atomic enough for this small, non-secret config file.
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

export function updateAppConfig(
  configPath: string,
  patch: Partial<Omit<AppConfigFile, "version" | "updatedAt">>,
): AppConfigFile {
  const current = readAppConfig(configPath);
  const next: AppConfigFile = { ...current, ...patch, version: APP_CONFIG_VERSION };
  if (next.dataRoot !== undefined) {
    next.dataRoot = path.resolve(next.dataRoot);
  }
  writeAppConfig(configPath, next);
  return next;
}

/**
 * Resolution order is explicit: environment override, then the wizard's
 * persisted choice, then the OS default. The source is returned so the UI can
 * explain when a path is managed by the environment.
 */
export function resolveDataRoot(options: ResolveDataRootOptions = {}): ResolvedDataRoot {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? appConfigPath(platform, env, homeDir);

  const envRoot = env.AGENT_IN_BOX_DATA_ROOT?.trim();
  if (envRoot) {
    return { root: path.resolve(envRoot), source: "environment", configPath };
  }

  const config = readAppConfig(configPath);
  if (config.dataRoot) {
    return { root: config.dataRoot, source: "config", configPath };
  }

  return { root: defaultDataRoot(platform, homeDir, env), source: "default", configPath };
}

export function ensureStorageLayout(layout: StorageLayout): void {
  for (const directory of [
    layout.root,
    layout.images,
    layout.downloads,
    layout.vms,
    layout.snapshots,
    layout.artifacts,
    layout.archives,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}
