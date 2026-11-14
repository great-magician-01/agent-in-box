import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../persistence/database";
import type { DatabaseService } from "../persistence/database.service";
import { PluginDevelopmentService } from "./plugin-development.service";
import { PluginService } from "./plugin.service";

const NOW = "2026-01-01T00:00:00.000Z";
const fixtures: Array<{
  directory: string;
  app: AppDatabase;
  development: PluginDevelopmentService;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.development.onModuleDestroy();
    if (fixture.app.sqlite.open) await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("PluginDevelopmentService", () => {
  it("registers inspected AI bytes but requires explicit auto-enable authorization", async () => {
    const fixture = await fixtureWithBroker(false);
    const inspected = await post(fixture, "/v1/inspect", { files: packageFiles() });
    expect(inspected.status).toBe(200);
    const packageSha256 = inspected.body.packageSha256 as string;

    const registered = await post(fixture, "/v1/register", {
      files: packageFiles(),
      testReport: { status: "passed", packageSha256, command: "npm test", exitCode: 0 },
    });
    expect(registered.status).toBe(200);
    expect(registered.body.autoEnableAllowed).toBe(false);
    expect(registered.body.plugin).toMatchObject({
      pluginId: "local.broker",
      version: "1.0.0",
      source: "ai",
    });

    const denied = await post(fixture, "/v1/enable", {
      pluginId: "local.broker",
      version: "1.0.0",
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");
  });

  it("limits automatic enablement to the token's current project", async () => {
    const fixture = await fixtureWithBroker(true);
    const inspected = await post(fixture, "/v1/inspect", { files: packageFiles() });
    const packageSha256 = inspected.body.packageSha256 as string;
    await post(fixture, "/v1/register", {
      files: packageFiles(),
      testReport: { status: "passed", packageSha256 },
    });
    const enabled = await post(fixture, "/v1/enable", {
      pluginId: "local.broker",
      version: "1.0.0",
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enablement).toMatchObject({
      scopeType: "project",
      scopeId: "project-1",
      enabled: true,
    });
  });

  it("rejects invalid and revoked bearer tokens", async () => {
    const fixture = await fixtureWithBroker(true);
    const denied = await post(fixture, "/v1/inspect", { files: packageFiles() }, "wrong-token");
    expect(denied.status).toBe(401);
    await fixture.development.revokeWorker("worker-1");
    const revoked = await post(fixture, "/v1/inspect", { files: packageFiles() });
    expect(revoked.status).toBe(401);
  });
});

async function fixtureWithBroker(autoEnable: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aib-plugin-broker-"));
  const root = path.join(directory, "data");
  const app = AppDatabase.open({ filename: path.join(root, "agent-in-box.sqlite") });
  await app.migrate();
  await app.db
    .insertInto("projects")
    .values({
      id: "project-1",
      name: "Development project",
      description: "",
      default_vm_binding_id: null,
      workspace_config_json: "{}",
      agent_config_json: "{}",
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    })
    .execute();
  const plugins = new PluginService(app.db, { layout: { root } } as unknown as DatabaseService);
  const development = new PluginDevelopmentService(app.db, plugins, { port: 0 });
  await development.onModuleInit();
  const issued = await development.issue({
    workerId: "worker-1",
    projectId: "project-1",
    autoEnable,
  });
  const fixture = {
    directory,
    app,
    development,
    token: issued.token,
    baseUrl: `http://127.0.0.1:${development.port}`,
  };
  fixtures.push(fixture);
  return fixture;
}

async function post(
  fixture: { baseUrl: string; token: string },
  route: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> & { error?: { code?: string } } }> {
  const response = await fetch(`${fixture.baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? fixture.token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function packageFiles(): Array<{ path: string; dataBase64: string }> {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({
      schemaVersion: 1,
      id: "local.broker",
      version: "1.0.0",
      displayName: "Broker plugin",
      apiVersion: 1,
      targets: ["worker"],
      entrypoints: { worker: "index.js" },
      runtime: { kind: "pi-extension", minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
    }),
    "index.js": "export default function register() {}\n",
    "package.json": JSON.stringify({ name: "local-broker", version: "1.0.0" }),
  };
  return Object.entries(files).map(([filePath, content]) => ({
    path: filePath,
    dataBase64: Buffer.from(content).toString("base64"),
  }));
}
