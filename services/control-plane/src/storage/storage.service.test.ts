import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAppConfig, storageLayout, writeAppConfig } from "@agent-in-box/config";
import { AppDatabase } from "../persistence/database";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import type { DatabaseService } from "../persistence/database.service";
import { StorageService, type StorageServiceOptions } from "./storage.service";
import { StorageError, StorageLockedError } from "./storage-errors";

const temporaryDirectories: string[] = [];
const openDatabases: AppDatabase[] = [];

afterEach(async () => {
  for (const app of openDatabases.splice(0)) {
    if (app.sqlite.open) {
      await app.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  dir: string;
  root: string;
  configPath: string;
  lockPath: string;
  app: AppDatabase;
  catalog: CatalogRepository;
  service: StorageService;
}

async function createFixture(
  options: Partial<StorageServiceOptions> & { source?: "config" | "environment" } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-storage-"));
  temporaryDirectories.push(dir);
  const root = path.join(dir, "data 根目录");
  const configPath = path.join(dir, "config", "app-config.json");
  const lockPath = path.join(dir, "config", "storage.lock");
  writeAppConfig(configPath, { version: 1, dataRoot: root, closeBehavior: "quit" });

  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(path.join(root, "images", "base.qcow2"), "base image");
  await mkdir(path.join(root, "downloads"), { recursive: true });
  await writeFile(path.join(root, "downloads", "cache.partial"), "partial download");
  await mkdir(path.join(root, "vms", "vm-1"), { recursive: true });
  await writeFile(path.join(root, "vms", "vm-1", "disk.qcow2"), "disk data");
  await mkdir(path.join(root, "snapshots", "vm-1"), { recursive: true });
  await writeFile(path.join(root, "snapshots", "vm-1", "snap-1.qcow2"), "snapshot");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(path.join(root, "artifacts", "result.txt"), "artifact");
  await mkdir(path.join(root, "archives"), { recursive: true });
  await writeFile(path.join(root, "archives", "worker.json"), "archive");

  const app = AppDatabase.open({ filename: path.join(root, "agent-in-box.sqlite") });
  openDatabases.push(app);
  await app.migrate();
  const catalog = new CatalogRepository(app.db);
  await catalog.createProject({ name: "Storage test project" });

  const source = options.source ?? "config";
  const fakeDatabase = {
    dataRoot: root,
    dataRootSource: source,
    configPath,
    layout: storageLayout(root),
    filename: path.join(root, "agent-in-box.sqlite"),
    db: app.db,
    backup: (destination: string) => app.backup(destination),
  } as unknown as DatabaseService;

  const service = new StorageService(fakeDatabase, {
    platform: "linux",
    hostname: "test-host",
    pid: 4242,
    processAlive: (pid) => pid === 4242,
    qemuImg: null,
    configuredRoot: root,
    dataRootSource: source,
    configPath,
    lockPath,
    owner: "tester@test-host",
    now: () => new Date("2026-11-10T00:00:00.000Z"),
    ...options,
  });

  return { dir, root, configPath, lockPath, app, catalog, service };
}

describe("storage path validation", () => {
  it("creates and validates a path with spaces and unicode", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.dir, "新的 存储 目录");

    const validation = await fixture.service.validateRoot(target);

    expect(validation.ok).toBe(true);
    expect(validation.writable).toBe(true);
    expect(validation.directory).toBe(true);
    expect(validation.layout.vms).toBe(path.join(target, "vms"));
  });

  it("rejects relative paths, disk roots and files", async () => {
    const fixture = await createFixture();
    const file = path.join(fixture.dir, "not-a-directory");
    await writeFile(file, "file");

    expect((await fixture.service.validateRoot("relative/path")).errors).toContain(
      "存储路径必须是绝对路径",
    );
    expect((await fixture.service.validateRoot("/")).errors.length).toBeGreaterThan(0);
    expect((await fixture.service.validateRoot(file)).errors).toContain("所选路径已存在但不是目录");
  });

  it.skipIf(process.platform === "win32")("resolves symlinks and reports a warning", async () => {
    const fixture = await createFixture();
    const realTarget = path.join(fixture.dir, "real-target");
    const link = path.join(fixture.dir, "link-target");
    await mkdir(realTarget);
    await symlink(realTarget, link);

    const validation = await fixture.service.validateRoot(link);

    expect(validation.ok).toBe(true);
    expect(validation.resolvedPath).toBe(realTarget);
    expect(validation.warnings.join("\n")).toContain("符号链接");
  });

  it.skipIf(process.platform === "win32")("reports an unwritable directory", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const fixture = await createFixture();
    const target = path.join(fixture.dir, "read-only");
    await mkdir(target);
    await chmod(target, 0o555);

    const validation = await fixture.service.validateRoot(target);

    expect(validation.ok).toBe(false);
    expect(validation.writable).toBe(false);
    expect(validation.errors.join("\n")).toContain("不可写");
    await chmod(target, 0o755);
  });
});

describe("storage lock", () => {
  it("rejects concurrent operations and releases cleanly", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.acquireLock("test_one");

    await expect(fixture.service.acquireLock("test_two")).rejects.toBeInstanceOf(
      StorageLockedError,
    );
    expect(await fixture.service.getLockInfo()).toMatchObject({
      pid: 4242,
      operation: "test_one",
    });

    await first.release();
    const second = await fixture.service.acquireLock("test_two");
    expect(second.info.operation).toBe("test_two");
    await second.release();
  });

  it("replaces a lock left by a dead process", async () => {
    const fixture = await createFixture();
    await mkdir(path.dirname(fixture.lockPath), { recursive: true });
    await writeFile(
      fixture.lockPath,
      JSON.stringify({
        token: "stale",
        owner: "dead@test-host",
        pid: 999999,
        hostname: "test-host",
        acquiredAt: "2026-11-10T00:00:00.000Z",
        operation: "crashed",
      }),
    );

    const lock = await fixture.service.acquireLock("recovered");
    expect(lock.info.operation).toBe("recovered");
    await lock.release();
  });
});

describe("storage migration", () => {
  it("copies and verifies every category, backs up SQLite and updates config", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.dir, "new-storage");
    const result = await fixture.service.migrateTo(target);

    expect(result.from).toBe(fixture.root);
    expect(result.to).toBe(target);
    expect(result.filesCopied).toBe(6);
    expect(result.verifiedFiles).toBe(6);
    expect(result.bytesCopied).toBeGreaterThan(0);
    expect(result.restartRequired).toBe(true);
    expect(result.configUpdated).toBe(true);
    expect(result.oldDataRetained).toBe(true);

    for (const [relative, content] of [
      ["images/base.qcow2", "base image"],
      ["downloads/cache.partial", "partial download"],
      ["vms/vm-1/disk.qcow2", "disk data"],
      ["snapshots/vm-1/snap-1.qcow2", "snapshot"],
      ["artifacts/result.txt", "artifact"],
      ["archives/worker.json", "archive"],
    ]) {
      expect(await readFile(path.join(target, relative), "utf8")).toBe(content);
      expect(await readFile(path.join(fixture.root, relative), "utf8")).toBe(content);
    }

    const config = readAppConfig(fixture.configPath);
    expect(config.dataRoot).toBe(target);
    expect(config.closeBehavior).toBe("quit");
    expect(config.pendingMigration).toBeUndefined();
    expect(fixture.service.configurationStatus()).toEqual({
      restartRequired: true,
      configuredRoot: target,
    });
    await expect(stat(fixture.lockPath)).rejects.toThrow();

    const targetDatabase = AppDatabase.open({ filename: path.join(target, "agent-in-box.sqlite") });
    try {
      const project = await targetDatabase.db.selectFrom("projects").selectAll().executeTakeFirst();
      expect(project?.name).toBe("Storage test project");
      const audit = await targetDatabase.db
        .selectFrom("storage_migrations")
        .selectAll()
        .executeTakeFirst();
      expect(audit?.status).toBe("completed");
      expect(audit?.files_copied).toBe(6);
    } finally {
      await targetDatabase.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "leaves the old path usable when copying fails",
    async () => {
      const fixture = await createFixture();
      await symlink("/tmp", path.join(fixture.root, "images", "external-link"));
      const target = path.join(fixture.dir, "broken-target");

      await expect(fixture.service.migrateTo(target)).rejects.toBeInstanceOf(StorageError);

      const config = readAppConfig(fixture.configPath);
      expect(config.dataRoot).toBe(fixture.root);
      expect(config.pendingMigration).toBeUndefined();
      expect(await readFile(path.join(fixture.root, "images", "base.qcow2"), "utf8")).toBe(
        "base image",
      );
      const project = await fixture.app.db.selectFrom("projects").selectAll().executeTakeFirst();
      expect(project?.name).toBe("Storage test project");
      await expect(stat(target)).rejects.toThrow();

      const audit = await fixture.app.db
        .selectFrom("storage_migrations")
        .selectAll()
        .executeTakeFirst();
      expect(audit?.status).toBe("failed");
    },
  );

  it("refuses to migrate when the root is controlled by the environment", async () => {
    const fixture = await createFixture({ source: "environment" });

    await expect(
      fixture.service.migrateTo(path.join(fixture.dir, "elsewhere")),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("configures the current root without moving data", async () => {
    const fixture = await createFixture();
    await fixture.service.configureCurrentRoot(fixture.root);

    expect(readAppConfig(fixture.configPath)).toMatchObject({
      dataRoot: fixture.root,
      closeBehavior: "quit",
    });
    expect(fixture.service.configurationStatus()).toEqual({
      restartRequired: false,
      configuredRoot: fixture.root,
    });
    await expect(
      fixture.service.configureCurrentRoot(path.join(fixture.dir, "other")),
    ).rejects.toBeInstanceOf(StorageError);
  });
});

describe("storage report and cleanup", () => {
  it("reports category usage and only deletes the download cache", async () => {
    const fixture = await createFixture();
    const report = await fixture.service.getReport();

    expect(report.root).toBe(fixture.root);
    expect(report.categories.find((item) => item.category === "downloads")?.files).toBe(1);
    expect(report.categories.find((item) => item.category === "vms")?.files).toBe(1);
    expect(report.databaseBytes).toBeGreaterThan(0);

    const cleanup = await fixture.service.cleanupDownloads();
    expect(cleanup.filesDeleted).toBe(1);
    expect(cleanup.bytesFreed).toBeGreaterThan(0);

    expect(await readFile(path.join(fixture.root, "vms", "vm-1", "disk.qcow2"), "utf8")).toBe(
      "disk data",
    );
    expect(await readFile(path.join(fixture.root, "artifacts", "result.txt"), "utf8")).toBe(
      "artifact",
    );
    await expect(stat(path.join(fixture.root, "downloads", "cache.partial"))).rejects.toThrow();
  });
});
