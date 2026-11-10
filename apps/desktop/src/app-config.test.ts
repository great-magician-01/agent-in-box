import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCloseBehavior,
  readDesktopConfig,
  resolveDesktopPaths,
  setCloseBehavior,
  writeDesktopConfig,
} from "./app-config";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-desktop-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop paths", () => {
  it("uses the shared OS config directory", () => {
    expect(
      resolveDesktopPaths("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "/x"),
    ).toMatchObject({
      configDirectory: path.join("C:\\Users\\me\\AppData\\Roaming", "AgentInBox"),
    });
    expect(
      resolveDesktopPaths("linux", { XDG_CONFIG_HOME: "/home/me/.config" }, "/home/me"),
    ).toMatchObject({
      configDirectory: path.join("/home/me/.config", "agent-in-box"),
      logDirectory: path.join("/home/me/.config", "agent-in-box", "logs"),
    });
    expect(
      resolveDesktopPaths("linux", { AGENT_IN_BOX_CONFIG_DIR: "/tmp/config" }, "/x"),
    ).toMatchObject({
      configPath: path.join(path.resolve("/tmp/config"), "app-config.json"),
      credentialsPath: path.join(path.resolve("/tmp/config"), "credentials.json"),
    });
  });
});

describe("desktop config", () => {
  it("preserves the data root and pending migration when toggling close behavior", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    writeDesktopConfig(file, {
      version: 1,
      dataRoot: path.join(directory, "data"),
      onboardingCompletedAt: "2026-11-10T00:00:00.000Z",
      pendingMigration: {
        targetRoot: path.join(directory, "target"),
        startedAt: "2026-11-10T00:00:00.000Z",
        operation: "storage_migrate",
      },
    });

    expect(getCloseBehavior(file)).toBe("keep_running");
    setCloseBehavior(file, "quit");

    const config = readDesktopConfig(file);
    expect(config).toMatchObject({
      dataRoot: path.join(directory, "data"),
      closeBehavior: "quit",
      pendingMigration: {
        targetRoot: path.join(directory, "target"),
        operation: "storage_migrate",
      },
    });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("rejects invalid close behavior values", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "app-config.json");
    expect(() => setCloseBehavior(file, "sometimes" as never)).toThrow("无效");
  });
});
