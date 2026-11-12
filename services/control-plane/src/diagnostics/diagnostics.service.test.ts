import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../persistence/database";
import { DatabaseService } from "../persistence/database.service";
import { SettingsService } from "../settings/settings.service";
import { DiagnosticsService } from "./diagnostics.service";

let directory: string;
let app: AppDatabase;
let service: DiagnosticsService;
let configDirectory: string;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-diagnostics-"));
  configDirectory = path.join(directory, "config");
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.mkdirSync(path.join(directory, "backups"), { recursive: true });
  const databaseFile = path.join(directory, "agent-in-box.sqlite");
  app = AppDatabase.open({ filename: databaseFile });
  await app.migrate();
  await app.db
    .insertInto("projects")
    .values({
      id: "project-diagnostics",
      name: "Diagnostics project",
      description: "",
      default_vm_binding_id: null,
      workspace_config_json: "{}",
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
      archived_at: null,
    })
    .execute();

  const fakeDatabase = {
    dataRoot: directory,
    dataRootSource: "config",
    configPath: path.join(configDirectory, "app-config.json"),
    filename: databaseFile,
    backupsDirectory: path.join(directory, "backups"),
    db: app.db,
  } as unknown as DatabaseService;
  const settings = new SettingsService(app.db);
  service = new DiagnosticsService(fakeDatabase, settings, app.db);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("DiagnosticsService", () => {
  it("exports counts, migrations and checks without credentials", async () => {
    fs.writeFileSync(
      path.join(configDirectory, "web-access-key"),
      "aib_test_access_key_1234567890\n",
    );

    const report = await service.report();
    expect(report.warning).toContain("敏感");
    expect(report.product.protocolVersion).toBe("0.1.0");
    expect(report.database.appliedMigrations).toContain("011_phase12_hardening");
    expect(report.database.pendingMigrations).toEqual([]);
    expect(report.database.quickCheck).toBe("ok");
    expect(report.database.tableCounts.projects).toBe(1);
    expect(report.state.tasksByStatus).toEqual({});
    expect(report.checks.find((check) => check.name === "SQLite 完整性")?.status).toBe("ok");
    expect(report.settings.security.requireApprovalForSensitiveActions).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("aib_test_access_key_1234567890");
  });

  it("redacts common credential shapes from captured logs", async () => {
    const logs = path.join(configDirectory, "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "desktop.log.1"),
      `${JSON.stringify({
        time: "2026-11-12T00:00:00.000Z",
        level: "info",
        scope: "control-plane",
        message: "older line",
        data: { token: "older-token-secret", safe: "visible" },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(logs, "desktop.log"),
      [
        "control-plane failed with Bearer abcdefghijklmnop and sk-live-abcdefghijklmnopqrstuvwxyz",
        `access key aib_${"A".repeat(24)}`,
        'apiKey="sk-ant-abcdefghijklmnop"',
        "cookie aib_session=session-secret-value",
        '{"appSecret":"feishu-secret-value","token":"qq-token-value","message":"visible text"}',
      ].join("\n"),
    );

    const report = await service.report();
    expect(report.logs.content).toContain("visible text");
    expect(report.logs.content).toContain("[REDACTED");
    expect(report.logs.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(report.logs.content).not.toContain("session-secret-value");
    expect(report.logs.content).not.toContain("feishu-secret-value");
    expect(report.logs.content).not.toContain("qq-token-value");
    expect(report.logs.content).not.toContain("A".repeat(24));
    expect(report.logs.files.map((file) => file.name).sort()).toEqual([
      "desktop.log",
      "desktop.log.1",
    ]);
  });

  it("lists migration backups with checksums", async () => {
    const backup = path.join(directory, "backups", "pre-migration-test.sqlite");
    fs.copyFileSync(path.join(directory, "agent-in-box.sqlite"), backup);
    fs.writeFileSync(`${backup}.sha256`, `${"a".repeat(64)}  pre-migration-test.sqlite\n`);
    const report = await service.report();
    expect(report.database.migrationBackups).toHaveLength(1);
    expect(report.database.migrationBackups[0]?.sha256).toBe("a".repeat(64));
  });
});
