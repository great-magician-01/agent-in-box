import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { smokeAuthHeaders } from "./smoke-auth.mjs";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.SMOKE_PORT ?? "3981");
const baseUrl = `http://127.0.0.1:${port}`;
const temporary = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-smoke-"));
const configDirectory = path.join(temporary, "config");
const homeDirectory = path.join(temporary, "home");
const targetRoot = path.join(temporary, "目标 数据 目录");
let child = null;
let log = "";

function controlPlaneEnv() {
  return {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    LOCALAPPDATA: path.join(homeDirectory, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
    XDG_DATA_HOME: path.join(homeDirectory, ".local", "share"),
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    CONTROL_PLANE_HOST: "127.0.0.1",
    CONTROL_PLANE_PORT: String(port),
    AGENT_IN_BOX_WEB_ROOT: path.join(root, "apps", "web", "dist"),
    NODE_ENV: "test",
  };
}

async function startControlPlane() {
  child = spawn(
    process.execPath,
    [path.join(root, "services", "control-plane", "dist", "main.js")],
    {
      cwd: root,
      env: controlPlaneEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`control-plane exited early with ${child.exitCode}\n${log}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`control-plane did not become healthy\n${log}`);
}

async function stopControlPlane() {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  const stopping = child;
  child = null;
  const exited = new Promise((resolve) => stopping.once("exit", resolve));
  stopping.kill("SIGTERM");
  const result = await Promise.race([
    exited.then(() => "exited"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (result === "timeout" && stopping.exitCode === null) {
    stopping.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

async function json(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: smokeAuthHeaders(configDirectory, body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function createSeedData(dataRoot) {
  const files = {
    "images/base.qcow2": "base-image",
    "vms/vm-smoke/disk.qcow2": "vm-disk",
    "snapshots/vm-smoke/snap-1.qcow2": "snapshot",
    "artifacts/result.txt": "phase2-smoke-artifact",
    "downloads/cache.partial": "partial",
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dataRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

async function main() {
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });

  console.log(`[smoke] temporary data: ${temporary}`);
  await startControlPlane();
  console.log("[smoke] health ok");

  const onboarding = await json("GET", "/api/v1/onboarding");
  assert.equal(onboarding.required, true, JSON.stringify(onboarding));
  assert.equal(onboarding.dataRootSource, "default");
  const oldRoot = onboarding.dataRoot;
  createSeedData(oldRoot);

  const host = await json("GET", "/api/v1/host/inspection");
  console.log(
    `[smoke] host checks: ${host.checks.map((check) => `${check.id}=${check.status}`).join(", ")}`,
  );
  assert.equal(host.supported, true, "host must be a supported OS");
  assert.equal(host.ready, true, `host checks failed: ${JSON.stringify(host.checks)}`);

  const validation = await json("POST", "/api/v1/storage/validate", { path: targetRoot });
  assert.equal(validation.ok, true);
  assert.equal(validation.resolvedPath, targetRoot);

  const invalidResponse = await fetch(`${baseUrl}/api/v1/storage/validate`, {
    method: "POST",
    headers: smokeAuthHeaders(configDirectory, { "content-type": "application/json" }),
    body: JSON.stringify({ path: "relative/path" }),
  });
  assert.equal(invalidResponse.status, 200);
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.ok, false);
  assert.ok(invalidBody.errors.length > 0, "invalid paths must explain why they failed");

  const malformedResponse = await fetch(`${baseUrl}/api/v1/storage/validate`, {
    method: "POST",
    headers: smokeAuthHeaders(configDirectory, { "content-type": "application/json" }),
    body: JSON.stringify([]),
  });
  assert.equal(malformedResponse.status, 400);
  const malformedBody = await malformedResponse.json();
  assert.equal(malformedBody.ok, false);
  assert.equal(malformedBody.error.code, "validation_failed");

  const result = await json("POST", "/api/v1/onboarding/complete", {
    dataRoot: targetRoot,
    resourcePolicy: {
      hostReserveBytes: 2 * 1024 * 1024 * 1024,
      autoStartPolicy: "manual",
    },
    security: { requireApprovalForSensitiveActions: true },
    displayName: "Smoke Admin",
    preferredModelProvider: "anthropic",
    credentialsConfigured: true,
  });
  assert.equal(result.restartRequired, true);
  assert.equal(result.state.required, false);
  assert.equal(result.state.dataRoot, targetRoot);
  assert.equal(result.state.restartRequired, true);
  assert.equal(result.state.configuredDataRoot, targetRoot);
  assert.equal(result.state.localUser.displayName, "Smoke Admin");
  console.log(
    `[smoke] migrated ${result.storageMigration.filesCopied} files / ${result.storageMigration.bytesCopied} bytes`,
  );

  for (const [relative, content] of Object.entries({
    "images/base.qcow2": "base-image",
    "vms/vm-smoke/disk.qcow2": "vm-disk",
    "snapshots/vm-smoke/snap-1.qcow2": "snapshot",
    "artifacts/result.txt": "phase2-smoke-artifact",
  })) {
    assert.equal(readFileSync(path.join(targetRoot, relative), "utf8"), content);
    assert.equal(readFileSync(path.join(oldRoot, relative), "utf8"), content, "old data retained");
  }
  assert.equal(readFileSync(path.join(targetRoot, "agent-in-box.sqlite")).length > 0, true);

  await stopControlPlane();
  console.log("[smoke] restarting control plane with persisted data root");
  await startControlPlane();

  const after = await json("GET", "/api/v1/onboarding");
  assert.equal(after.required, false);
  assert.equal(after.dataRoot, targetRoot);
  assert.equal(after.restartRequired, false);
  assert.equal(after.configuredDataRoot, targetRoot);
  assert.equal(after.completedAt !== null, true);

  const storage = await json("GET", "/api/v1/storage");
  assert.equal(storage.root, targetRoot);
  assert.equal(storage.pendingMigration, null);
  assert.equal(
    storage.categories.find((item) => item.category === "vms").files,
    1,
    "VM files must be visible after restart",
  );
  const settings = await json("GET", "/api/v1/settings");
  assert.equal(settings.resourcePolicy.hostReserveBytes, 2 * 1024 * 1024 * 1024);

  console.log("[smoke] onboarding, migration and restart reconciliation passed");
}

try {
  await main();
} catch (error) {
  console.error(`[smoke] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  if (log) {
    console.error("--- control-plane log tail ---");
    console.error(log.split("\n").slice(-40).join("\n"));
  }
  process.exitCode = 1;
} finally {
  await stopControlPlane();
  rmSync(temporary, { recursive: true, force: true });
}
