import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UpdateManager,
  backupDatabase,
  compareVersions,
  createRollbackSnapshot,
  parseUpdateManifest,
  restoreDatabase,
  restoreRollbackSnapshot,
} from "./updates";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-updates-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("update manifest", () => {
  it("compares versions and selects the matching architecture", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    const parsed = parseUpdateManifest(
      {
        version: "0.2.0",
        notes: "phase 11",
        files: [
          {
            platform: "win32",
            arch: "x64",
            url: "https://example.com/agent.exe",
            sha256: "a".repeat(64),
            sizeBytes: 100,
          },
        ],
      },
      { platform: "win32", arch: "x64", currentVersion: "0.1.0" },
    );
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.installArgs).toEqual(["/S"]);
  });

  it("rejects insecure URLs, bad hashes and missing platform files", () => {
    const base = {
      version: "0.2.0",
      files: [
        {
          platform: "win32",
          arch: "x64",
          url: "https://example.com/a.exe",
          sha256: "a".repeat(64),
        },
      ],
    };
    expect(() =>
      parseUpdateManifest(
        { ...base, files: [{ ...base.files[0], url: "http://example.com/a.exe" }] },
        { platform: "win32", arch: "x64", currentVersion: "0.1.0" },
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseUpdateManifest(
        { ...base, files: [{ ...base.files[0], sha256: "nope" }] },
        { platform: "win32", arch: "x64", currentVersion: "0.1.0" },
      ),
    ).toThrow(/SHA-256/);
    expect(() =>
      parseUpdateManifest(base, { platform: "darwin", arch: "arm64", currentVersion: "0.1.0" }),
    ).toThrow(/darwin/);
  });

  it("rejects a version that escapes the installer directory", () => {
    const base = {
      version: "0.2.0",
      files: [
        {
          platform: "win32",
          arch: "x64",
          url: "https://example.com/a.exe",
          sha256: "a".repeat(64),
        },
      ],
    };
    expect(() =>
      parseUpdateManifest(
        { ...base, version: "0.2.0-../../../../Startup/evil" },
        { platform: "win32", arch: "x64", currentVersion: "0.1.0" },
      ),
    ).toThrow(/安全的语义化版本号/);
    expect(() =>
      parseUpdateManifest(
        { ...base, version: "0.2.0-rc.1+build.5" },
        { platform: "win32", arch: "x64", currentVersion: "0.1.0" },
      ),
    ).not.toThrow();
  });
});

describe("UpdateManager", () => {
  it("downloads, verifies and exposes a ready installer", async () => {
    const installer = Buffer.from("phase11-installer");
    const sha256 = createHash("sha256").update(installer).digest("hex");
    const server = http.createServer((request, response) => {
      if (request.url === "/latest.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            version: "0.2.0",
            notes: "test",
            files: [
              {
                platform: "win32",
                arch: "x64",
                url: `http://127.0.0.1:${(server.address() as { port: number }).port}/agent.exe`,
                sha256,
                sizeBytes: installer.length,
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/agent.exe") {
        response.writeHead(200, { "content-length": installer.length });
        response.end(installer);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const directory = temporaryDirectory();
    const manager = new UpdateManager({
      currentVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      directory,
      feedUrl: () => `http://127.0.0.1:${port}/latest.json`,
    });
    try {
      const checked = await manager.check();
      expect(checked.state).toBe("available");
      expect(checked.availableVersion).toBe("0.2.0");

      const downloaded = await manager.download();
      expect(downloaded.state).toBe("ready");
      expect(downloaded.downloadProgress).toBe(1);
      const ready = manager.getReady();
      expect(ready).not.toBeNull();
      expect(fs.readFileSync(ready!.installerPath)).toEqual(installer);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed on a checksum mismatch and when no feed is configured", async () => {
    const directory = temporaryDirectory();
    const noFeed = new UpdateManager({
      currentVersion: "0.1.0",
      directory,
      feedUrl: () => null,
    });
    expect((await noFeed.check()).state).toBe("error");
    expect((await noFeed.check()).error).toContain("更新源");

    const server = http.createServer((request, response) => {
      if (request.url === "/latest.json") {
        response.end(
          JSON.stringify({
            version: "0.2.0",
            files: [
              {
                platform: "linux",
                arch: "x64",
                url: `http://127.0.0.1:${(server.address() as { port: number }).port}/agent.bin`,
                sha256: "0".repeat(64),
              },
            ],
          }),
        );
        return;
      }
      response.end("tampered");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const manager = new UpdateManager({
      currentVersion: "0.1.0",
      platform: "linux",
      arch: "x64",
      directory,
      feedUrl: () => `http://127.0.0.1:${port}/latest.json`,
    });
    try {
      expect((await manager.check()).state).toBe("available");
      const downloaded = await manager.download();
      expect(downloaded.state).toBe("error");
      expect(downloaded.error).toContain("SHA-256");
      expect(manager.getReady()).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("update rollback files", () => {
  it("snapshots installed resources and restores them with the database", async () => {
    const root = temporaryDirectory();
    const resources = path.join(root, "resources");
    fs.mkdirSync(path.join(resources, "control-plane"), { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "v1");
    fs.writeFileSync(path.join(resources, "control-plane", "main.js"), "old");
    const snapshot = path.join(root, "backup", "resources");
    expect(await createRollbackSnapshot({ resourcesPath: resources, destination: snapshot })).toBe(
      true,
    );
    fs.writeFileSync(path.join(resources, "app.asar"), "v2");
    await restoreRollbackSnapshot({ source: snapshot, resourcesPath: resources });
    expect(fs.readFileSync(path.join(resources, "app.asar"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(resources, "control-plane", "main.js"), "utf8")).toBe("old");

    const databasePath = path.join(root, "data", "agent-in-box.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "before");
    const backup = path.join(root, "backup", "database");
    await backupDatabase({ databasePath, destination: backup });
    fs.writeFileSync(databasePath, "after");
    await restoreDatabase({ backupPath: backup, databasePath });
    expect(fs.readFileSync(databasePath, "utf8")).toBe("before");
  });
});
