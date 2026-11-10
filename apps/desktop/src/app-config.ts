import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloseBehavior } from "@agent-in-box/protocol";

export interface DesktopConfigFile {
  version: number;
  dataRoot?: string;
  onboardingCompletedAt?: string;
  closeBehavior?: CloseBehavior;
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
