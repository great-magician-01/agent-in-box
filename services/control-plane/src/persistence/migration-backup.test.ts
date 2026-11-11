import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./database";
import {
  createPreMigrationBackup,
  inspectMigrationBackup,
  listMigrationBackups,
  sha256File,
} from "./migration-backup";
import { appliedMigrationIds, migrateToLatest, pendingMigrationIds } from "./migrations";

let directory: string;
let databaseFile: string;
let backupsDirectory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-migration-backup-"));
  databaseFile = path.join(directory, "agent-in-box.sqlite");
  backupsDirectory = path.join(directory, "backups");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("pre-migration backup", () => {
  it("does not create a backup when all migrations are applied", async () => {
    const app = AppDatabase.open({ filename: databaseFile });
    await app.migrate();
    const result = await createPreMigrationBackup({
      app,
      directory: backupsDirectory,
      appliedMigrationIds: await appliedMigrationIds(app.db),
      pendingMigrationIds: await pendingMigrationIds(app.db),
    });
    expect(result).toBeNull();
    await app.close();
  });

  it("creates a verified backup before a pending migration and preserves data", async () => {
    const app = AppDatabase.open({ filename: databaseFile });
    await app.migrate();
    await app.db
      .insertInto("projects")
      .values({
        id: "project-before-upgrade",
        name: "Before upgrade",
        description: "must survive the migration",
        default_vm_binding_id: null,
        workspace_config_json: "{}",
        created_at: "2026-11-12T00:00:00.000Z",
        updated_at: "2026-11-12T00:00:00.000Z",
        archived_at: null,
      })
      .execute();
    await app.db
      .deleteFrom("schema_migrations")
      .where("id", "=", "011_phase12_hardening")
      .execute();

    const applied = await appliedMigrationIds(app.db);
    const pending = await pendingMigrationIds(app.db);
    expect(pending).toEqual(["011_phase12_hardening"]);

    const backup = await createPreMigrationBackup({
      app,
      directory: backupsDirectory,
      appliedMigrationIds: applied,
      pendingMigrationIds: pending,
      now: () => new Date("2026-11-12T01:02:03.004Z"),
    });
    expect(backup).not.toBeNull();
    expect(backup?.fileName).toMatch(/^pre-migration-.*011_phase12_hardening.*\.sqlite$/);
    expect(fs.existsSync(backup!.path)).toBe(true);
    expect(await sha256File(backup!.path)).toBe(backup!.sha256);
    expect(fs.readFileSync(`${backup!.path}.sha256`, "utf8")).toContain(backup!.sha256);
    await inspectMigrationBackup(backup!.path);

    const snapshot = new BetterSqlite3(backup!.path, { readonly: true });
    try {
      const project = snapshot
        .prepare("select name from projects where id = ?")
        .get("project-before-upgrade") as { name: string } | undefined;
      expect(project?.name).toBe("Before upgrade");
      const migration = snapshot
        .prepare("select id from schema_migrations where id = ?")
        .get("011_phase12_hardening");
      expect(migration).toBeUndefined();
    } finally {
      snapshot.close();
    }

    expect(await app.migrate()).toEqual(["011_phase12_hardening"]);
    expect(await pendingMigrationIds(app.db)).toEqual([]);
    const index = app.sqlite
      .prepare("select name from sqlite_master where type = 'index' and name = ?")
      .get("tasks_status_created_idx");
    expect(index).toBeTruthy();

    const restoreFile = path.join(directory, "restored.sqlite");
    fs.copyFileSync(backup!.path, restoreFile);
    const restored = new BetterSqlite3(restoreFile, { readonly: true });
    try {
      const count = restored
        .prepare("select count(*) as count from projects where id = ?")
        .get("project-before-upgrade") as { count: number };
      expect(count.count).toBe(1);
    } finally {
      restored.close();
    }
    await app.close();
  });

  it("keeps only the newest configured number of pre-migration backups", async () => {
    const app = AppDatabase.open({ filename: databaseFile });
    await app.migrate();
    await app.db
      .deleteFrom("schema_migrations")
      .where("id", "=", "011_phase12_hardening")
      .execute();
    const applied = await appliedMigrationIds(app.db);
    const pending = await pendingMigrationIds(app.db);
    for (const hour of [1, 2, 3]) {
      await createPreMigrationBackup({
        app,
        directory: backupsDirectory,
        appliedMigrationIds: applied,
        pendingMigrationIds: pending,
        keep: 2,
        now: () => new Date(`2026-11-12T0${hour}:00:00.000Z`),
      });
      // Ensure mtimes differ even on filesystems with coarse timestamps.
      const files = fs
        .readdirSync(backupsDirectory)
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => path.join(backupsDirectory, name));
      for (const file of files) {
        const stamp = new Date(`2026-11-12T0${hour}:00:00.000Z`);
        fs.utimesSync(file, stamp, stamp);
      }
    }
    const backups = await listMigrationBackups(backupsDirectory, 10);
    expect(backups).toHaveLength(2);
    expect(backups.every((backup) => backup.sha256.length === 64)).toBe(true);
    await app.close();
  });

  it("refuses to continue when the pre-migration backup cannot be written", async () => {
    const app = AppDatabase.open({ filename: databaseFile });
    await app.migrate();
    const failingApp = {
      backup: async () => {
        throw new Error("disk full");
      },
    } as unknown as AppDatabase;
    await expect(
      createPreMigrationBackup({
        app: failingApp,
        directory: backupsDirectory,
        appliedMigrationIds: ["001_initial_schema"],
        pendingMigrationIds: ["011_phase12_hardening"],
      }),
    ).rejects.toThrow(/已停止启动|disk full/);
    expect(
      fs.existsSync(backupsDirectory) &&
        fs.readdirSync(backupsDirectory).some((name) => name.endsWith(".sqlite")),
    ).toBe(false);
    await app.close();
  });

  it("re-runs the latest migration idempotently", async () => {
    const app = AppDatabase.open({ filename: databaseFile });
    await migrateToLatest(app.db);
    await app.db
      .deleteFrom("schema_migrations")
      .where("id", "=", "011_phase12_hardening")
      .execute();
    await expect(migrateToLatest(app.db)).resolves.toEqual(["011_phase12_hardening"]);
    await app.close();
  });
});
