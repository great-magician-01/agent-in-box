import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDesktopPreferences, normalizeUpdateFeedUrl, setDesktopPreferences } from "./app-config";
import {
  AUTOSTART_FILENAME,
  applyLoginItem,
  linuxAutostartEntry,
  linuxAutostartPath,
} from "./login-item";
import {
  DATA_ROOT_MARKER,
  cleanUninstallData,
  resolveDesktopDataRoot,
  validateDataRootForDeletion,
} from "./uninstall-cleanup";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-desktop-phase11-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop preferences", () => {
  it("persists launch-at-login, notification and update settings", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    expect(getDesktopPreferences(file)).toEqual({
      closeBehavior: "keep_running",
      launchAtLogin: false,
      notificationsEnabled: true,
      autoUpdateCheck: false,
      updateFeedUrl: null,
    });
    const next = setDesktopPreferences(file, {
      closeBehavior: "quit",
      launchAtLogin: true,
      notificationsEnabled: false,
      autoUpdateCheck: true,
      updateFeedUrl: "https://updates.example.com/latest.json",
    });
    expect(next).toMatchObject({
      closeBehavior: "quit",
      launchAtLogin: true,
      notificationsEnabled: false,
      autoUpdateCheck: true,
      updateFeedUrl: "https://updates.example.com/latest.json",
    });
    expect(getDesktopPreferences(file)).toEqual(next);
  });

  it("only accepts HTTPS feeds and loopback HTTP for tests", () => {
    expect(normalizeUpdateFeedUrl("https://example.com/latest.json")).toBe(
      "https://example.com/latest.json",
    );
    expect(normalizeUpdateFeedUrl("http://127.0.0.1:9999/latest.json")).toBe(
      "http://127.0.0.1:9999/latest.json",
    );
    expect(normalizeUpdateFeedUrl("http://example.com/latest.json")).toBeNull();
    expect(normalizeUpdateFeedUrl("file:///tmp/latest.json")).toBeNull();
    const directory = temporaryDirectory();
    expect(() =>
      setDesktopPreferences(path.join(directory, "app-config.json"), {
        updateFeedUrl: "http://example.com/latest.json",
      }),
    ).toThrow(/HTTPS/);
  });
});

describe("launch at login", () => {
  it("writes and removes a freedesktop autostart entry", () => {
    const directory = temporaryDirectory();
    const env = { XDG_CONFIG_HOME: directory };
    applyLoginItem({
      enabled: true,
      platform: "linux",
      execPath: "/opt/Agent in Box/agent-in-box",
      env,
      homeDir: directory,
    });
    const file = linuxAutostartPath(env, directory);
    expect(path.basename(file)).toBe(AUTOSTART_FILENAME);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('Exec="/opt/Agent in Box/agent-in-box" --hidden');
    expect(content).toContain("X-GNOME-Autostart-enabled=true");
    applyLoginItem({ enabled: false, platform: "linux", env, homeDir: directory });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("uses the platform login-item API on Windows and macOS", () => {
    const calls: unknown[] = [];
    applyLoginItem({
      enabled: true,
      platform: "win32",
      loginItemApi: {
        setLoginItemSettings: (settings) => calls.push(settings),
      },
    });
    expect(calls).toEqual([{ openAtLogin: true, openAsHidden: true, args: ["--hidden"] }]);
    const escapedExecPath = process.execPath.replace(/(["\\`$])/g, "\\$1");
    expect(linuxAutostartEntry(process.execPath)).toContain(escapedExecPath);
  });
});

describe("uninstall cleanup", () => {
  function dataRootWithMarker(directory: string): string {
    const dataRoot = path.join(directory, "custom-data");
    fs.mkdirSync(path.join(dataRoot, "vms"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "vms", "disk.qcow2"), "vm");
    fs.writeFileSync(path.join(dataRoot, "agent-in-box.sqlite"), "db");
    fs.writeFileSync(
      path.join(dataRoot, DATA_ROOT_MARKER),
      JSON.stringify({ product: "Agent-in-Box", version: 1, kind: "data-root" }),
    );
    return dataRoot;
  }

  it("only deletes a marked data root and known config entries", () => {
    const directory = temporaryDirectory();
    const dataRoot = dataRootWithMarker(directory);
    const configDirectory = path.join(directory, "config");
    fs.mkdirSync(path.join(configDirectory, "logs"), { recursive: true });
    fs.writeFileSync(path.join(configDirectory, "app-config.json"), "{}");
    fs.writeFileSync(path.join(configDirectory, "web-access-key"), "secret");
    fs.writeFileSync(path.join(configDirectory, "unrelated.txt"), "keep me");
    const result = cleanUninstallData({
      dataRoot,
      configDirectory,
      homeDir: path.join(directory, "home"),
    });
    expect(result.errors).toEqual([]);
    expect(result.dataRootDeleted).toBe(true);
    expect(fs.existsSync(dataRoot)).toBe(false);
    expect(fs.existsSync(path.join(configDirectory, "unrelated.txt"))).toBe(true);
    expect(fs.existsSync(path.join(configDirectory, "app-config.json"))).toBe(false);
    expect(fs.existsSync(path.join(configDirectory, "logs"))).toBe(false);
  });

  it("refuses filesystem roots, home ancestors and unmarked directories", () => {
    const directory = temporaryDirectory();
    expect(validateDataRootForDeletion(path.parse(directory).root).ok).toBe(false);
    expect(
      validateDataRootForDeletion(directory, { homeDir: path.join(directory, "child") }).ok,
    ).toBe(false);
    const unmarked = path.join(directory, "data");
    fs.mkdirSync(unmarked);
    expect(validateDataRootForDeletion(unmarked, { homeDir: "/home/other" }).ok).toBe(false);
  });

  it("resolves a custom data root before deleting", () => {
    const directory = temporaryDirectory();
    const configPath = path.join(directory, "config", "app-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, dataRoot: "/custom/data" }));
    expect(resolveDesktopDataRoot({ configPath })).toBe(path.resolve("/custom/data"));
    expect(
      resolveDesktopDataRoot({
        configPath,
        env: { AGENT_IN_BOX_DATA_ROOT: "/env/data" },
      }),
    ).toBe(path.resolve("/env/data"));
  });
});
