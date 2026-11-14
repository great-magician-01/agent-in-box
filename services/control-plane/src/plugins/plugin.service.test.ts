import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPluginPackage } from "@agent-in-box/plugin-runtime";
import type { PluginRegisterRequest } from "@agent-in-box/protocol";
import { AppDatabase } from "../persistence/database";
import type { DatabaseService } from "../persistence/database.service";
import { PluginService } from "./plugin.service";

const NOW = "2026-01-01T00:00:00.000Z";
const PLUGIN_ID = "com.example.hello";
const PLUGIN_VERSION = "1.0.0";
const ENTRY = "index.js";
const ENTRY_CONTENT = 'export default "hello";\n';

interface Fixture {
  dir: string;
  root: string;
  app: AppDatabase;
  service: PluginService;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.app.sqlite.open) await fixture.app.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aib-plugin-"));
  const root = path.join(dir, "data");
  await mkdir(root, { recursive: true });
  const app = AppDatabase.open({ filename: path.join(root, "agent-in-box.sqlite") });
  await app.migrate();
  const database = { layout: { root } } as unknown as DatabaseService;
  const service = new PluginService(app.db, database);
  const fixture = { dir, root, app, service };
  fixtures.push(fixture);
  return fixture;
}

async function writePluginPackage(
  parent: string,
  options: {
    id?: string;
    version?: string;
    entry?: string;
    entryContent?: string;
    targets?: string[];
    displayName?: string;
  } = {},
): Promise<string> {
  const id = options.id ?? PLUGIN_ID;
  const version = options.version ?? PLUGIN_VERSION;
  const entry = options.entry ?? ENTRY;
  const root = await mkdtemp(path.join(parent, "package-"));
  const entryPath = path.join(root, ...entry.split("/"));
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version,
      displayName: options.displayName ?? "Hello plugin",
      apiVersion: 1,
      targets: options.targets ?? ["worker"],
      entrypoints: { worker: entry },
      runtime: { kind: "pi-extension", minPiVersion: "1.5.0", minAppVersion: "0.1.0" },
    }),
  );
  await writeFile(entryPath, options.entryContent ?? ENTRY_CONTENT);
  await writeFile(path.join(root, "notes.txt"), `package ${id}@${version}\n`);
  return root;
}

function register(
  service: PluginService,
  sourcePath: string,
  source: "user" | "ai" = "user",
  testReport?: Record<string, unknown>,
) {
  const request: PluginRegisterRequest = { sourcePath, source };
  if (testReport) request.testReport = testReport;
  return service.register(request);
}

async function insertProject(app: AppDatabase, id = "project-1"): Promise<void> {
  await app.db
    .insertInto("projects")
    .values({
      id,
      name: "Plugin project",
      description: "",
      default_vm_binding_id: null,
      workspace_config_json: "{}",
      agent_config_json: "{}",
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    })
    .execute();
}

describe("PluginService", () => {
  it("copies a user package into the managed root and enforces immutable versions", async () => {
    const { app, root, service } = await createFixture();
    const source = await writePluginPackage(root);
    const inspected = await inspectPluginPackage(source);

    const registered = await register(service, source);
    expect(registered).toMatchObject({
      pluginId: PLUGIN_ID,
      displayName: "Hello plugin",
      version: PLUGIN_VERSION,
      status: "registered",
      source: "user",
      packageSha256: inspected.packageSha256,
      manifest: expect.objectContaining({ id: PLUGIN_ID, version: PLUGIN_VERSION }),
    });

    const managedRoot = path.join(root, "plugins", PLUGIN_ID, PLUGIN_VERSION);
    const row = await app.db.selectFrom("plugin_versions").selectAll().executeTakeFirstOrThrow();
    expect(row.package_root).toBe(managedRoot);
    expect(row.package_sha256).toBe(inspected.packageSha256);
    expect(await readFile(path.join(managedRoot, ENTRY), "utf8")).toBe(ENTRY_CONTENT);
    expect(await readFile(path.join(managedRoot, "notes.txt"), "utf8")).toContain(
      `${PLUGIN_ID}@${PLUGIN_VERSION}`,
    );
    expect(await readdir(path.join(root, "plugins", ".staging"))).toEqual([]);

    const identical = await register(service, source);
    expect(identical.packageSha256).toBe(inspected.packageSha256);
    expect(await app.db.selectFrom("plugin_versions").selectAll().execute()).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);

    // Editing the source package must not mutate the managed copy.
    await writeFile(path.join(source, ENTRY), 'export default "changed";\n');
    expect(await readFile(path.join(managedRoot, ENTRY), "utf8")).toBe(ENTRY_CONTENT);
    await expect(register(service, source)).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires AI registrations to present a passing report for the exact package hash", async () => {
    const { root, service } = await createFixture();
    const source = await writePluginPackage(root);
    const { packageSha256 } = await inspectPluginPackage(source);
    const wrongHash = "0".repeat(64);

    await expect(register(service, source, "ai")).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      register(service, source, "ai", { status: "failed", packageSha256 }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      register(service, source, "ai", { status: "passed", packageSha256: wrongHash }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const report = { status: "passed", packageSha256, checks: ["manifest", "load"] };
    const registered = await register(service, source, "ai", report);
    expect(registered.source).toBe("ai");
    expect(registered.testReport).toEqual(report);
    expect(await service.list()).toHaveLength(1);
  });

  it("validates enablement parameters and requires an existing scope", async () => {
    const { app, root, service } = await createFixture();
    const source = await writePluginPackage(root);
    await register(service, source);
    await insertProject(app);

    await expect(
      service.enable(PLUGIN_ID, {
        version: PLUGIN_VERSION,
        scopeType: "global" as never,
        scopeId: "project-1",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      service.enable(PLUGIN_ID, {
        version: PLUGIN_VERSION,
        scopeType: "project",
        scopeId: "missing-project",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.enable(PLUGIN_ID, {
        version: PLUGIN_VERSION,
        scopeType: "worker",
        scopeId: "missing-worker",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.enable(PLUGIN_ID, {
        version: "9.9.9",
        scopeType: "project",
        scopeId: "project-1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const enabled = await service.enable(PLUGIN_ID, {
      version: PLUGIN_VERSION,
      scopeType: "project",
      scopeId: "project-1",
    });
    expect(enabled).toMatchObject({
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      scopeType: "project",
      scopeId: "project-1",
      enabled: true,
    });

    const enabledAgain = await service.enable(PLUGIN_ID, {
      version: PLUGIN_VERSION,
      scopeType: "project",
      scopeId: "project-1",
    });
    expect(enabledAgain.id).toBe(enabled.id);
    expect(await service.enablements("project", "project-1")).toHaveLength(1);
  });

  it("creates an immutable session snapshot and transfers package bytes to the worker", async () => {
    const { app, root, service } = await createFixture();
    const source = await writePluginPackage(root);
    const registered = await register(service, source);
    await insertProject(app);
    await service.enable(PLUGIN_ID, {
      version: PLUGIN_VERSION,
      scopeType: "project",
      scopeId: "project-1",
    });

    const snapshot = await service.snapshot("worker-1", "project-1");
    expect(snapshot.extensions).toEqual([
      {
        pluginId: PLUGIN_ID,
        version: PLUGIN_VERSION,
        packageSha256: registered.packageSha256,
        target: "worker",
        entryPath: ENTRY,
      },
    ]);
    expect(await service.snapshotById(snapshot.id)).toEqual(snapshot);

    const packages = await service.packages(snapshot);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      packageSha256: registered.packageSha256,
      entryPath: ENTRY,
    });
    const files = new Map(
      packages[0].files.map((file) => [
        file.path,
        Buffer.from(file.dataBase64, "base64").toString("utf8"),
      ]),
    );
    expect(JSON.parse(files.get("manifest.json") ?? "{}")).toMatchObject({ id: PLUGIN_ID });
    expect(files.get(ENTRY)).toBe(ENTRY_CONTENT);

    await service.disable(PLUGIN_ID, "project", "project-1");
    const disabled = await service.snapshot("worker-1", "project-1");
    expect(disabled.extensions).toEqual([]);
    expect(await service.packages(disabled)).toEqual([]);
  });

  it("quarantines a version whose managed files changed before enable", async () => {
    const { app, root, service } = await createFixture();
    const source = await writePluginPackage(root);
    await register(service, source);
    await insertProject(app);
    const row = await app.db.selectFrom("plugin_versions").selectAll().executeTakeFirstOrThrow();
    await writeFile(path.join(row.package_root, ENTRY), 'export default "tampered";\n');

    await expect(
      service.enable(PLUGIN_ID, {
        version: PLUGIN_VERSION,
        scopeType: "project",
        scopeId: "project-1",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const after = await app.db
      .selectFrom("plugin_versions")
      .select(["status", "error_message"])
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("quarantined");
    expect(after.error_message).toContain("哈希");
    expect(await service.enablements("project", "project-1")).toEqual([]);
  });

  it("refuses to sync a snapshot whose package was tampered with after creation", async () => {
    const { app, root, service } = await createFixture();
    const source = await writePluginPackage(root);
    await register(service, source);
    await insertProject(app);
    await service.enable(PLUGIN_ID, {
      version: PLUGIN_VERSION,
      scopeType: "project",
      scopeId: "project-1",
    });
    const snapshot = await service.snapshot("worker-1", "project-1");

    const row = await app.db.selectFrom("plugin_versions").selectAll().executeTakeFirstOrThrow();
    await writeFile(path.join(row.package_root, ENTRY), 'export default "tampered";\n');

    await expect(service.packages(snapshot)).rejects.toMatchObject({ code: "conflict" });

    const after = await app.db
      .selectFrom("plugin_versions")
      .select(["status", "error_message"])
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("quarantined");
    expect(after.error_message).toContain("哈希");
  });
});
