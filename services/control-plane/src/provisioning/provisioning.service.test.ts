import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseService } from "../persistence/database.service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { ProvisioningService } from "./provisioning.service";

const ASSETS = [
  "guest-agent",
  "worker-runtime.tar.gz",
  "node-linux-x64.tar.xz",
  "pi-coding-agent.tgz",
  "install.sh",
  "agent-in-box-worker.service",
  "worker.env.example",
  "cua-extension.js",
  "agent-in-box-guest-agent.service",
];

let ctx: TestContext;
let runtimeDir: string;
let service: ProvisioningService | null;

beforeEach(async () => {
  ctx = await createTestContext();
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-runtime-"));
  const assets = [];
  for (const name of ASSETS) {
    const content = Buffer.from(`test asset ${name}\n`);
    await writeFile(path.join(runtimeDir, name), content);
    assets.push({
      name,
      fileName: name,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  await writeFile(
    path.join(runtimeDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      guestRuntimeVersion: "0.1.0",
      profile: "linux-desktop-worker",
      nodeVersion: "24.18.0",
      piVersion: "1.5.1",
      assets,
    }),
  );
  process.env.AGENT_IN_BOX_GUEST_RUNTIME_DIR = runtimeDir;
  process.env.AGENT_IN_BOX_PROVISIONING_PORT = "0";
  await writeFile(path.join(ctx.dir, "guest-agent.token"), "guest-secret", { mode: 0o600 });
  await writeFile(path.join(ctx.dir, "worker-rpc.token"), "worker-secret", { mode: 0o600 });
  service = new ProvisioningService({ dataRoot: ctx.dir } as DatabaseService, ctx.app.db);
  await service.onModuleInit();
});

afterEach(async () => {
  service?.onModuleDestroy();
  service = null;
  delete process.env.AGENT_IN_BOX_GUEST_RUNTIME_DIR;
  delete process.env.AGENT_IN_BOX_PROVISIONING_PORT;
  await rm(runtimeDir, { recursive: true, force: true });
  await ctx.close();
});

function baseUrl(): string {
  const context = service!.contextFor(ctx.vmId);
  return context.url.replace("10.0.2.2", "127.0.0.1");
}

describe("ProvisioningService", () => {
  it("serves a NoCloud user-data script without leaking provider secrets", async () => {
    expect(service!.availableFor("linux-desktop-worker")).toBe(true);
    const meta = await fetch(`${baseUrl()}meta-data`);
    expect(meta.status).toBe(200);
    expect(await meta.text()).toContain(`instance-id: ${ctx.vmId}`);

    const response = await fetch(`${baseUrl()}user-data`);
    expect(response.status).toBe(200);
    const userData = await response.text();
    expect(userData).toContain("#cloud-config");
    expect(userData).toContain("xfce4");
    expect(userData).toContain("agent-in-box-guest-agent.service");
    expect(userData).toContain("install.sh");
    expect(userData).toContain("--rpc-token-file");
    expect(userData).not.toContain("apiKey");
    expect(userData).not.toContain("provider-secret");

    const row = await ctx.app.db
      .selectFrom("vm_instances")
      .select(["provisioning_state"])
      .where("id", "=", ctx.vmId)
      .executeTakeFirstOrThrow();
    expect(row.provisioning_state).toBe("installing");
    const secretStat = await stat(path.join(ctx.dir, "provisioning.key"));
    if (process.platform !== "win32") {
      expect(secretStat.mode & 0o077).toBe(0);
    }
  });

  it("rejects invalid tokens and does not expose arbitrary paths", async () => {
    const valid = baseUrl();
    const invalid = valid.replace(/\/[^/]+\/$/, "/invalid-token/");
    expect((await fetch(`${invalid}meta-data`)).status).toBe(403);
    expect((await fetch(`${valid}assets/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${valid}tokens/random.txt`)).status).toBe(404);
  });

  it("serves per-VM tokens and revokes provisioning data after ready", async () => {
    const base = baseUrl();
    const guest = await fetch(`${base}tokens/guest-agent.token`);
    expect(await guest.text()).toBe("guest-secret");
    const worker = await fetch(`${base}tokens/worker-rpc.token`);
    expect(await worker.text()).toBe("worker-secret");

    expect((await fetch(`${base}ready`, { method: "POST" })).status).toBe(200);
    const row = await ctx.app.db
      .selectFrom("vm_instances")
      .select(["provisioning_state", "guest_health"])
      .where("id", "=", ctx.vmId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ provisioning_state: "ready", guest_health: "healthy" });
    expect((await fetch(`${base}user-data`)).status).toBe(410);
    expect((await fetch(`${base}assets/guest-agent`)).status).toBe(410);
  });

  it("records guest provisioning failures", async () => {
    const base = baseUrl();
    expect(
      (
        await fetch(`${base}fail?message=apt%20failed`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const row = await ctx.app.db
      .selectFrom("vm_instances")
      .select(["provisioning_state", "provisioning_message"])
      .where("id", "=", ctx.vmId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      provisioning_state: "failed",
      provisioning_message: "apt failed",
    });
  });
});
