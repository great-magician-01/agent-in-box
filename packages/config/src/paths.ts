import os from "node:os";
import path from "node:path";

export const DEFAULT_CONTROL_PLANE_HOST = "127.0.0.1";
export const DEFAULT_CONTROL_PLANE_PORT = 3000;

export interface ControlPlaneConfig {
  host: string;
  port: number;
}

export interface StorageLayout {
  root: string;
  images: string;
  downloads: string;
  vms: string;
  snapshots: string;
  artifacts: string;
  archives: string;
  database: string;
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CONTROL_PLANE_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid CONTROL_PLANE_PORT: ${raw}`);
  }
  return parsed;
}

export function controlPlaneConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  return {
    host: env.CONTROL_PLANE_HOST?.trim() || DEFAULT_CONTROL_PLANE_HOST,
    port: readPort(env.CONTROL_PLANE_PORT),
  };
}

/**
 * OS default data root. Business code should call resolveDataRoot() instead so
 * the user's first-run choice is honored; this is only the fallback.
 */
export function defaultDataRoot(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.AGENT_IN_BOX_DATA_ROOT?.trim()) {
    return path.resolve(env.AGENT_IN_BOX_DATA_ROOT.trim());
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "AgentInBox");
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "AgentInBox");
  }

  return path.join(homeDir, ".local", "share", "agent-in-box");
}

export function storageLayout(root: string = defaultDataRoot()): StorageLayout {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    images: path.join(resolved, "images"),
    downloads: path.join(resolved, "downloads"),
    vms: path.join(resolved, "vms"),
    snapshots: path.join(resolved, "snapshots"),
    artifacts: path.join(resolved, "artifacts"),
    archives: path.join(resolved, "archives"),
    database: path.join(resolved, "agent-in-box.sqlite"),
  };
}

export function vmDirectory(layout: StorageLayout, vmId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(vmId)) {
    throw new Error("Invalid VM id for storage path");
  }
  return path.join(layout.vms, vmId);
}
