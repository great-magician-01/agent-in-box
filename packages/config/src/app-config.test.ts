import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appConfigDirectory,
  appConfigPath,
  ensureStorageLayout,
  readAppConfig,
  resolveDataRoot,
  storageLayout,
  updateAppConfig,
  writeAppConfig,
} from "./index";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("app config location", () => {
  it("uses the OS configuration directory", () => {
    expect(
      appConfigDirectory("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "/home/me"),
    ).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "AgentInBox"));
    expect(appConfigDirectory("linux", { XDG_CONFIG_HOME: "/home/me/.config" }, "/home/me")).toBe(
      "/home/me/.config/agent-in-box",
    );
    expect(appConfigDirectory("darwin", {}, "/Users/me")).toBe(
      "/Users/me/Library/Application Support/AgentInBox",
    );
  });

  it("honors the explicit config directory override", () => {
    expect(
      appConfigDirectory("linux", { AGENT_IN_BOX_CONFIG_DIR: "/tmp/aib-config" }, "/home/me"),
    ).toBe("/tmp/aib-config");
    expect(appConfigPath("linux", { AGENT_IN_BOX_CONFIG_DIR: "/tmp/aib-config" })).toBe(
      "/tmp/aib-config/app-config.json",
    );
  });
});

describe("app config persistence", () => {
  it("returns defaults when the file does not exist", () => {
    const file = path.join(temporaryDirectory(), "app-config.json");
    expect(readAppConfig(file)).toEqual({ version: 1 });
  });

  it("round-trips unicode paths and close behavior", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    const dataRoot = path.join(directory, "数据 盘", "Agent Box");

    writeAppConfig(file, {
      version: 1,
      dataRoot,
      onboardingCompletedAt: "2026-11-10T00:00:00.000Z",
      closeBehavior: "keep_running",
    });

    const config = readAppConfig(file);
    expect(config.dataRoot).toBe(dataRoot);
    expect(config.onboardingCompletedAt).toBe("2026-11-10T00:00:00.000Z");
    expect(config.closeBehavior).toBe("keep_running");
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("updates one field without dropping the data root", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    writeAppConfig(file, { version: 1, dataRoot: path.join(directory, "data") });

    updateAppConfig(file, { closeBehavior: "quit" });

    expect(readAppConfig(file)).toMatchObject({
      dataRoot: path.join(directory, "data"),
      closeBehavior: "quit",
    });
  });

  it("rejects a corrupt config instead of silently losing the data root", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    writeFileSync(file, "{not-json");

    expect(() => readAppConfig(file)).toThrow("Invalid application config JSON");
  });
});

describe("data root resolution", () => {
  it("prefers the environment override", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    writeAppConfig(file, { version: 1, dataRoot: path.join(directory, "configured") });

    const resolved = resolveDataRoot({
      platform: "linux",
      homeDir: directory,
      configPath: file,
      env: { AGENT_IN_BOX_DATA_ROOT: path.join(directory, "from-env") },
    });

    expect(resolved.root).toBe(path.join(directory, "from-env"));
    expect(resolved.source).toBe("environment");
  });

  it("uses the wizard choice before the OS default", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    writeAppConfig(file, { version: 1, dataRoot: path.join(directory, "selected") });

    const resolved = resolveDataRoot({
      platform: "linux",
      homeDir: directory,
      configPath: file,
      env: {},
    });

    expect(resolved.root).toBe(path.join(directory, "selected"));
    expect(resolved.source).toBe("config");
  });

  it("falls back to the OS default and creates every storage directory", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");

    const resolved = resolveDataRoot({
      platform: "linux",
      homeDir: directory,
      configPath: file,
      env: {},
    });
    expect(resolved.source).toBe("default");
    expect(resolved.root).toBe(path.join(directory, ".local", "share", "agent-in-box"));

    const layout = storageLayout(resolved.root);
    ensureStorageLayout(layout);
    for (const key of [
      "root",
      "images",
      "downloads",
      "vms",
      "snapshots",
      "artifacts",
      "archives",
    ] as const) {
      expect(statSync(layout[key]).isDirectory()).toBe(true);
    }
  });
});
