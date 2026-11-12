import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { smokeAuthHeaders } from "./smoke-auth.mjs";
import type { ModelConfigurationView, RouterView, VmInstanceView } from "@agent-in-box/protocol";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase14-"));
const configDirectory = path.join(temporary, "config");
const children: ChildProcess[] = [];
const checks: string[] = [];
const controlPlanePort = await freePort();
const provisioningPort = await freePort();
const provisioningSecret = Buffer.from("phase14-provisioning-secret-0123456789abcdef");
const vmId = "phase14-linux-vm";

function passed(message: string): void {
  checks.push(message);
  console.log(`PASS: ${message}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const done = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${controlPlanePort}${route}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      ...smokeAuthHeaders(configDirectory),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${text}`);
  return payload as T;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${controlPlanePort}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Control plane did not become healthy");
}

async function startControlPlane(): Promise<void> {
  await writeFile(path.join(temporary, "provisioning.key"), provisioningSecret, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(repository, "services/control-plane/dist/main.js")], {
    cwd: repository,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(controlPlanePort),
      AGENT_IN_BOX_DATA_ROOT: temporary,
      AGENT_IN_BOX_CONFIG_DIR: configDirectory,
      AGENT_IN_BOX_PROVISIONING_PORT: String(provisioningPort),
      AGENT_IN_BOX_GUEST_RUNTIME_DIR: path.join(
        repository,
        "release",
        "guest-runtime",
        "linux-amd64",
      ),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  await waitForHealth();
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const now = new Date().toISOString();
  const storageRoot = path.join(temporary, "vms", vmId);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(storageRoot, "guest-agent.token"), "phase14-guest-token", {
    mode: 0o600,
  });
  await writeFile(path.join(storageRoot, "worker-rpc.token"), "phase14-worker-token", {
    mode: 0o600,
  });
  await seed.db
    .insertInto("images")
    .values({
      id: "phase14-image",
      name: "Phase 14 Ubuntu",
      os_family: "linux",
      os_version: "24.04",
      architecture: "amd64",
      version: "20261017",
      status: "available",
      size_bytes: 621284352,
      checksum: "a".repeat(64),
      local_path: path.join(temporary, "ubuntu.qcow2"),
      created_at: now,
      verified_at: now,
      source_url: "https://mirrors.tuna.tsinghua.edu.cn/example.img",
      file_name: "ubuntu.qcow2",
      downloaded_bytes: 621284352,
      error_code: null,
      error_message: null,
      updated_at: now,
      seed_local_path: null,
      manifest_json: JSON.stringify({ provisioning: "linux-desktop-worker" }),
      provisioning_profile: "linux-desktop-worker",
    })
    .execute();
  await seed.db
    .insertInto("vm_instances")
    .values({
      id: vmId,
      name: "Phase 14 Linux",
      image_id: "phase14-image",
      os_family: "linux",
      cpu_count: 4,
      memory_bytes: 8 * 1024 * 1024 * 1024,
      disk_bytes: 40 * 1024 * 1024 * 1024,
      storage_root: storageRoot,
      power_state: "stopped",
      guest_health: "unknown",
      created_at: now,
      last_started_at: null,
      provisioning_state: "waiting",
      provisioning_message: "phase14 pending",
      provisioning_started_at: now,
    })
    .execute();
  await seed.close();

  await startControlPlane();

  const provider = await api<ModelConfigurationView["providers"][number]>(
    "/api/v1/models/providers/phase14",
    {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        credentialProviderId: "phase14",
        models: [{ id: "phase14-model" }],
        enabled: true,
      }),
    },
  );
  assert.equal(provider.id, "phase14");
  const selection = await api<ModelConfigurationView>("/api/v1/models/configuration", {
    method: "PUT",
    body: JSON.stringify({
      worker: { providerId: "phase14", model: "phase14-model" },
      router: { providerId: "phase14", model: "phase14-model" },
    }),
  });
  assert.deepEqual(selection.selection.worker, {
    providerId: "phase14",
    model: "phase14-model",
  });
  passed("Model Provider 与 Worker/Router 多套选择可通过前端 API 持久化");

  const router = await api<RouterView>("/api/v1/router/config", {
    method: "PUT",
    body: JSON.stringify({ providerId: "phase14", model: "phase14-model" }),
  });
  assert.equal(router.selectionSource, "settings");
  assert.equal(router.selectedProviderId, "phase14");
  passed("Router 可在空闲时切换模型并保留设置");

  const token = createHmac("sha256", provisioningSecret).update(vmId).digest("base64url");
  const base = `http://127.0.0.1:${provisioningPort}/v1/${vmId}/${token}/`;
  const userDataResponse = await fetch(`${base}user-data`);
  assert.equal(userDataResponse.status, 200);
  const userData = await userDataResponse.text();
  assert.match(userData, /xfce4/);
  assert.match(userData, /agent-in-box-worker/);
  assert.match(userData, /--rpc-token-file/);
  assert.doesNotMatch(userData, /phase14-guest-token/);
  const invalid = await fetch(`${base.replace(token, "invalid")}user-data`);
  assert.equal(invalid.status, 403);
  const vm = await api<VmInstanceView>(`/api/v1/vms/${vmId}`);
  assert.equal(vm.vm.provisioning.state, "installing");
  passed("Cloud-init provisioning 提供经过 token 校验的 user-data，且不泄漏 Guest Token");

  const ready = await fetch(`${base}ready`, { method: "POST" });
  assert.equal(ready.status, 200);
  const closed = await fetch(`${base}user-data`);
  assert.equal(closed.status, 410);
  const readyVm = await api<VmInstanceView>(`/api/v1/vms/${vmId}`);
  assert.equal(readyVm.vm.provisioning.state, "ready");
  passed("Provisioning 完成后撤销 bootstrap 数据并更新 VM 状态");

  console.log(`Phase 14 smoke passed ${checks.length} checks.`);
  const resultPath =
    process.env.AGENT_IN_BOX_PHASE14_RESULT ??
    path.join(repository, "tests", "phase14", "results", "latest-smoke.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        status: "success",
        checks,
        realQemu: false,
        browserElectronUi: false,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) await stopChild(child);
  await rm(temporary, { recursive: true, force: true });
}
