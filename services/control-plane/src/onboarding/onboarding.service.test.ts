import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAppConfig, storageLayout, writeAppConfig } from "@agent-in-box/config";
import type { HostInspectionReport } from "@agent-in-box/protocol";
import { AppDatabase } from "../persistence/database";
import type { DatabaseService } from "../persistence/database.service";
import { SettingsService, normalizeResourcePolicy } from "../settings/settings.service";
import { StorageService } from "../storage/storage.service";
import { OnboardingService } from "./onboarding.service";
import type { HostInspectionService } from "../host/host-inspection.service";

const GIB = 1024 * 1024 * 1024;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  dir: string;
  root: string;
  configPath: string;
  app: AppDatabase;
  settings: SettingsService;
  storage: StorageService;
  onboarding: OnboardingService;
  setHostReady(ready: boolean): void;
}

async function createFixture(source: "config" | "environment" = "config"): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-onboarding-"));
  temporaryDirectories.push(dir);
  const root = path.join(dir, "初始 数据");
  const configPath = path.join(dir, "config", "app-config.json");
  writeAppConfig(configPath, { version: 1, dataRoot: root });

  const app = AppDatabase.open({ filename: path.join(root, "agent-in-box.sqlite") });
  await app.migrate();

  const fakeDatabase = {
    dataRoot: root,
    dataRootSource: source,
    configPath,
    layout: storageLayout(root),
    filename: path.join(root, "agent-in-box.sqlite"),
    db: app.db,
    backup: (destination: string) => app.backup(destination),
  } as unknown as DatabaseService;

  const storage = new StorageService(fakeDatabase, {
    platform: "linux",
    hostname: "test-host",
    pid: 4242,
    processAlive: (pid) => pid === 4242,
    qemuImg: null,
    configuredRoot: root,
    dataRootSource: source,
    configPath,
    lockPath: path.join(dir, "storage.lock"),
  });
  const settings = new SettingsService(app.db);

  let ready = true;
  const host = {
    inspect: async (dataRoot?: string): Promise<HostInspectionReport> => ({
      platform: "linux",
      release: "test",
      architecture: "x64",
      supported: true,
      totalMemoryBytes: 16 * GIB,
      freeMemoryBytes: 8 * GIB,
      dataRoot: dataRoot ?? root,
      freeDiskBytes: 100 * GIB,
      ready,
      recommendedProvider: ready ? "qemu-kvm" : null,
      checks: [
        {
          id: "cpu_virtualization",
          status: ready ? "ok" : "error",
          message: ready ? "ok" : "未通过",
        },
      ],
      inspectedAt: "2026-11-10T00:00:00.000Z",
    }),
  } as unknown as HostInspectionService;
  const onboarding = new OnboardingService(settings, storage, host);

  return {
    dir,
    root,
    configPath,
    app,
    settings,
    storage,
    onboarding,
    setHostReady(value: boolean) {
      ready = value;
    },
  };
}

const request = (dataRoot: string) => ({
  dataRoot,
  resourcePolicy: { hostReserveBytes: 2 * GIB, autoStartPolicy: "manual" as const },
  security: { requireApprovalForSensitiveActions: true },
  displayName: "本机管理员",
  preferredModelProvider: "anthropic",
  credentialsConfigured: true,
});

describe("onboarding", () => {
  it("persists identity, policy and credential metadata without secrets", async () => {
    const fixture = await createFixture();
    const result = await fixture.onboarding.complete(request(fixture.root));

    expect(result.restartRequired).toBe(false);
    expect(result.storageMigration).toBeNull();
    expect(result.state).toMatchObject({
      required: false,
      completedAt: expect.any(String),
      dataRoot: fixture.root,
      restartRequired: false,
      preferredModelProvider: "anthropic",
      credentialsConfigured: true,
      localUser: {
        displayName: "本机管理员",
        role: "admin",
      },
      resourcePolicy: { hostReserveBytes: 2 * GIB, autoStartPolicy: "manual" },
      security: { requireApprovalForSensitiveActions: true },
    });

    const alwaysOn = await fixture.settings.getJson<boolean>("credentialsConfigured");
    expect(alwaysOn).toBe(true);
    const rawSettings = await fixture.app.db.selectFrom("app_settings").selectAll().execute();
    expect(JSON.stringify(rawSettings)).not.toContain("sk-");
  });

  it("migrates storage, keeps the old data and requires a restart", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.dir, "新的 数据 目录");
    const result = await fixture.onboarding.complete(request(target));

    expect(result.restartRequired).toBe(true);
    expect(result.storageMigration).toMatchObject({ from: fixture.root, to: target });
    expect(result.state.dataRoot).toBe(target);
    expect(result.state.required).toBe(false);
    expect(result.state.restartRequired).toBe(true);
    expect(result.state.configuredDataRoot).toBe(target);
    expect(readAppConfig(fixture.configPath).dataRoot).toBe(target);

    const targetDatabase = AppDatabase.open({ filename: path.join(target, "agent-in-box.sqlite") });
    try {
      const user = await targetDatabase.db.selectFrom("local_users").selectAll().executeTakeFirst();
      expect(user?.display_name).toBe("本机管理员");
      const settings = await targetDatabase.db
        .selectFrom("app_settings")
        .select(["key", "value_json"])
        .execute();
      expect(settings.some((row) => row.key === "onboarding")).toBe(true);
    } finally {
      await targetDatabase.close();
    }
    expect(await readFile(path.join(target, "agent-in-box.sqlite"))).toBeDefined();
  });

  it("does not complete when the host check fails", async () => {
    const fixture = await createFixture();
    fixture.setHostReady(false);

    await expect(fixture.onboarding.complete(request(fixture.root))).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect((await fixture.onboarding.state()).required).toBe(true);
  });

  it("refuses to move an environment-managed root", async () => {
    const fixture = await createFixture("environment");

    await expect(
      fixture.onboarding.complete(request(path.join(fixture.dir, "other"))),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await fixture.onboarding.state()).required).toBe(true);
  });

  it("updates resource and security preferences after onboarding", async () => {
    const fixture = await createFixture();
    await fixture.onboarding.complete(request(fixture.root));

    const state = await fixture.onboarding.updateSettings({
      resourcePolicy: { hostReserveBytes: 3 * GIB, autoStartPolicy: "when_needed" },
      security: { requireApprovalForSensitiveActions: false },
    });

    expect(state.resourcePolicy).toEqual({
      hostReserveBytes: 3 * GIB,
      autoStartPolicy: "when_needed",
    });
    expect(state.security.requireApprovalForSensitiveActions).toBe(false);
  });
});

describe("settings validation", () => {
  it("rejects values that would starve the host or the VMs", () => {
    expect(() =>
      normalizeResourcePolicy({ hostReserveBytes: -1, autoStartPolicy: "manual" }, 16 * GIB),
    ).toThrow("Host Reserve");
    expect(() =>
      normalizeResourcePolicy({ hostReserveBytes: 16 * GIB, autoStartPolicy: "manual" }, 16 * GIB),
    ).toThrow("Host Reserve");
    expect(() =>
      normalizeResourcePolicy(
        { hostReserveBytes: 2 * GIB, autoStartPolicy: "sometimes" },
        16 * GIB,
      ),
    ).toThrow("自动启动策略");
  });
});
