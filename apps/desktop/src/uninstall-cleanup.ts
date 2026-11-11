import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDesktopConfig } from "./app-config";

export const DATA_ROOT_MARKER = ".agent-in-box-data-root";

export function resolveDesktopDataRoot(input: {
  configPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  const fromEnv = env.AGENT_IN_BOX_DATA_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const config = readDesktopConfig(input.configPath);
  if (config.dataRoot) {
    return path.resolve(config.dataRoot);
  }
  if (platform === "win32") {
    return path.join(
      env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local"),
      "AgentInBox",
    );
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "AgentInBox");
  }
  return path.join(homeDir, ".local", "share", "agent-in-box");
}

/**
 * Data-root deletion is only allowed when the directory carries the marker
 * written by the control plane and is not a filesystem root, the home
 * directory, or one of its ancestors.
 */
export function validateDataRootForDeletion(
  dataRoot: string,
  input: { homeDir?: string } = {},
): { ok: true } | { ok: false; reason: string } {
  const resolved = path.resolve(dataRoot);
  if (!path.isAbsolute(dataRoot)) {
    return { ok: false, reason: "数据目录不是绝对路径" };
  }
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return { ok: false, reason: "拒绝删除文件系统根目录" };
  }
  const home = path.resolve(input.homeDir ?? os.homedir());
  if (resolved === home || home.startsWith(`${resolved}${path.sep}`)) {
    return { ok: false, reason: "拒绝删除用户主目录或其上级目录" };
  }
  const marker = path.join(resolved, DATA_ROOT_MARKER);
  if (!fs.existsSync(marker)) {
    return { ok: false, reason: `缺少 Agent-in-Box 数据目录标记：${marker}` };
  }
  try {
    const info = JSON.parse(fs.readFileSync(marker, "utf8")) as { product?: unknown };
    if (info.product !== "Agent-in-Box") {
      return { ok: false, reason: "数据目录标记不属于 Agent-in-Box" };
    }
  } catch {
    return { ok: false, reason: "数据目录标记已损坏" };
  }
  return { ok: true };
}

const CONFIG_OWNED_ENTRIES = [
  "app-config.json",
  "credentials.json",
  "web-access-key",
  "credential-bridge.json",
  "logs",
  "electron",
  "updates",
] as const;

export interface UninstallCleanupResult {
  dataRoot: string;
  dataRootDeleted: boolean;
  configEntriesDeleted: string[];
  errors: string[];
}

export function cleanUninstallData(input: {
  dataRoot: string;
  configDirectory: string;
  homeDir?: string;
}): UninstallCleanupResult {
  const validation = validateDataRootForDeletion(input.dataRoot, {
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  const result: UninstallCleanupResult = {
    dataRoot: path.resolve(input.dataRoot),
    dataRootDeleted: false,
    configEntriesDeleted: [],
    errors: [],
  };
  if (!validation.ok) {
    result.errors.push(validation.reason);
  } else {
    try {
      fs.rmSync(path.resolve(input.dataRoot), { recursive: true, force: true });
      result.dataRootDeleted = true;
    } catch (error) {
      result.errors.push(
        `删除数据目录失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const entry of CONFIG_OWNED_ENTRIES) {
    const target = path.join(input.configDirectory, entry);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) {
        result.configEntriesDeleted.push(entry);
      }
    } catch (error) {
      result.errors.push(
        `删除 ${entry} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

export function isUninstallCleanupInvocation(argv: readonly string[]): boolean {
  return argv.includes("--uninstall-clean-data");
}
