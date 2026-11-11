import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LoginItemApi {
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    openAsHidden?: boolean;
    args?: string[];
  }): void;
}

export interface ApplyLoginItemOptions {
  enabled: boolean;
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loginItemApi?: LoginItemApi;
}

export const AUTOSTART_FILENAME = "agent-in-box.desktop";

export function linuxAutostartEntry(execPath: string): string {
  const escaped = execPath.replace(/(["\\`$])/g, "\\$1");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Agent-in-Box",
    "Comment=本地 AI 虚拟机工作平台后台服务",
    `Exec="${escaped}" --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "Categories=Utility;",
    "",
  ].join("\n");
}

export function linuxAutostartPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(
    env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config"),
    "autostart",
    AUTOSTART_FILENAME,
  );
}

export function applyLoginItem(options: ApplyLoginItemOptions): void {
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled;
  if (platform === "win32" || platform === "darwin") {
    const api = options.loginItemApi;
    if (!api) {
      throw new Error("登录启动 API 不可用");
    }
    api.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      args: ["--hidden"],
    });
    return;
  }
  const file = linuxAutostartPath(options.env, options.homeDir);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  const execPath = options.execPath ?? process.execPath;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, linuxAutostartEntry(execPath), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
