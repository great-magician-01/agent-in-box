import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type {
  ProjectBackupRecord,
  ProjectDetail,
  ResourceReconcileResult,
  ResourceReport,
  TaskBoardSnapshot,
  TaskDetail,
  TaskRecord,
  VmInstanceView,
  VmSnapshotImpact,
  VmSnapshotRecord,
} from "@agent-in-box/protocol";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface FakeVmState {
  id: string;
  powerState: string;
  pid: number;
  qmpPort: number;
  sshHostPort: number;
  guestHostPort: number;
  workerHostPort: number;
  consoleUrl: string;
  diskPath: string;
  guestHealth: string;
  lastError: string;
  updatedAt: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase9-"));
const resultPath =
  process.env.AGENT_IN_BOX_PHASE9_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase9/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const controlPlanePort = await freePort();
const supervisorPort = await freePort();
const modelBrokerPort = await freePort();
const cuaBrokerPort = await freePort();
const routerBrokerPort = await freePort();
const supervisorToken = "phase9-supervisor-token";
const guestToken = "phase9-guest-token";
const startedAt = new Date().toISOString();
let controlPlane: ChildProcess | undefined;
let supervisorServer: Server | undefined;
let guestServer: Server | undefined;
let sharedVmId = "";
let autoVmId = "";
let idleVmId = "";
let projectAId = "";
let projectBId = "";
const startCalls: string[] = [];
const suspendCalls: string[] = [];
const resumeCalls: string[] = [];
const snapshotTags: string[] = [];
const restoredSnapshotTags: string[] = [];
const deletedVmIds: string[] = [];
const restoredWorkspaces: string[] = [];
const states = new Map<string, FakeVmState>();
const watchdog = setTimeout(() => {
  console.error(`phase9 smoke watchdog timeout after ${checks.length} checks`);
  for (const child of children) child.kill("SIGKILL");
  process.exit(2);
}, 240_000);

function passed(name: string, detail?: string): void {
  checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
  console.log(`PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopChild(child: ChildProcess | undefined, timeoutMs = 15_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const done = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${controlPlanePort}${route}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = new Error(
      `${route} HTTP ${response.status}: ${JSON.stringify(payload)}`,
    ) as Error & {
      status?: number;
      payload?: unknown;
    };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

async function expectConflict(route: string, init: RequestInit): Promise<unknown> {
  try {
    await api(route, init);
    throw new Error(`${route} unexpectedly succeeded`);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 409) throw error;
    return (error as { payload?: unknown }).payload;
  }
}

function fakeState(id: string, powerState: string, guestPort: number): FakeVmState {
  return {
    id,
    powerState,
    pid: powerState === "stopped" ? 0 : 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: guestPort,
    workerHostPort: 0,
    consoleUrl: "vnc://127.0.0.1:5901",
    diskPath: path.join(temporary, "vms", id, "disk.qcow2"),
    guestHealth: "healthy",
    lastError: "",
    updatedAt: new Date().toISOString(),
  };
}

function tarHeader(name: string, content: Buffer, mtime: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write("0000600\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136, "utf8");
  header.write("        ", 148, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return header;
}

function tarGz(name: string, content: Buffer): Buffer {
  const header = tarHeader(name, content, 0);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function startControlPlane(): Promise<void> {
  controlPlane = spawn(
    process.execPath,
    [path.join(repository, "services/control-plane/dist/main.js")],
    {
      cwd: repository,
      env: {
        ...process.env,
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(controlPlanePort),
        AGENT_IN_BOX_DATA_ROOT: temporary,
        AGENT_IN_BOX_CONFIG_DIR: path.join(temporary, "config"),
        AGENT_IN_BOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisorPort}`,
        AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: path.join(temporary, "supervisor-acl.token"),
        AGENT_IN_BOX_MODEL_BROKER_PORT: String(modelBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_PORT: String(cuaBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_GUEST_URL: `http://127.0.0.1:${cuaBrokerPort}`,
        AGENT_IN_BOX_ROUTER_BROKER_PORT: String(routerBrokerPort),
        AGENT_IN_BOX_ROUTER_PI_BINARY: process.execPath,
        AGENT_IN_BOX_ROUTER_PI_ARGS: JSON.stringify([]),
        AGENT_IN_BOX_RESOURCE_TICK_MS: "3600000",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  children.push(controlPlane);
  await waitForHealth();
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${controlPlanePort}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (health.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Control plane did not become healthy");
}

function taskOf(taskId: string): Promise<TaskDetail> {
  return api<TaskDetail>(`/api/v1/tasks/${taskId}`);
}

function vmView(vmId: string): Promise<VmInstanceView> {
  return api<VmInstanceView>(`/api/v1/vms/${vmId}`);
}

async function createTask(projectId: string, vmId: string, objective: string): Promise<TaskRecord> {
  const result = await api<{ task: TaskRecord }>("/api/v1/tasks", {
    method: "POST",
    headers: { "x-idempotency-key": `phase9:${objective}` },
    body: JSON.stringify({ projectId, vmId, objective }),
  });
  return result.task;
}

async function setResourcePolicy(policy: Record<string, unknown>): Promise<void> {
  await api("/api/v1/settings", {
    method: "PATCH",
    body: JSON.stringify({
      resourcePolicy: {
        hostReserveBytes: 512 * 1024 ** 2,
        softMemoryBudgetBytes: 0,
        autoStartPolicy: "manual",
        idleSuspendEnabled: false,
        idleSuspendTimeoutMs: 60 * 60_000,
        ...policy,
      },
    }),
  });
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );

  const guest = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/workspace/archive") {
      const workspace = url.searchParams.get("path") ?? "";
      const payload = tarGz(
        "workspace.txt",
        Buffer.from(`phase9 workspace ${workspace} ${Date.now()}`),
      );
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(payload.length),
        "x-agent-in-box-sha256": createHash("sha256").update(payload).digest("hex"),
        "x-agent-in-box-files": "1",
      });
      response.end(payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspace/restore") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const workspace = url.searchParams.get("path") ?? "";
        restoredWorkspaces.push(workspace);
        writeJson(response, 200, {
          ok: true,
          path: workspace,
          fileCount: 1,
          sizeBytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      });
      return;
    }
    writeJson(response, 404, { error: { code: "not_found", message: "unknown guest route" } });
  });
  await new Promise<void>((resolve) => guest.listen(0, "127.0.0.1", () => resolve()));
  guestServer = guest;
  const guestPort = (guest.address() as AddressInfo).port;

  supervisorServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${supervisorToken}`) {
      writeJson(response, 401, { error: { code: "unauthorized", message: "invalid token" } });
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const match = /^\/api\/v1\/vms\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/api/v1/vms") {
      writeJson(response, 200, { items: [...states.values()] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/vms") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const spec = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: string };
        const id = spec.id ?? `vm-${Date.now()}`;
        const created = fakeState(id, "stopped", guestPort);
        states.set(id, created);
        writeJson(response, 201, created);
      });
      return;
    }
    if (!match) {
      writeJson(response, 404, { error: { code: "not_found", message: "route not found" } });
      return;
    }
    const [, vmId = "", action = "", subAction = ""] = match;
    const state = states.get(vmId);
    if (!state) {
      writeJson(response, 404, { error: { code: "not_found", message: "vm not found" } });
      return;
    }
    if (request.method === "GET" && !action) {
      writeJson(response, 200, state);
      return;
    }
    if (request.method === "DELETE" && !action) {
      deletedVmIds.push(vmId);
      states.delete(vmId);
      writeJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && action === "start") {
      startCalls.push(vmId);
      state.powerState = "running";
      state.pid = 4242;
      writeJson(response, 200, state);
      return;
    }
    if (request.method === "POST" && action === "stop") {
      state.powerState = "stopped";
      state.pid = 0;
      writeJson(response, 200, state);
      return;
    }
    if (request.method === "POST" && action === "suspend") {
      suspendCalls.push(vmId);
      state.powerState = "suspended";
      writeJson(response, 200, state);
      return;
    }
    if (request.method === "POST" && action === "resume") {
      resumeCalls.push(vmId);
      state.powerState = "running";
      state.pid = 4242;
      writeJson(response, 200, state);
      return;
    }
    if (request.method === "POST" && action === "snapshots" && !subAction) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tag?: string };
        snapshotTags.push(body.tag ?? "");
        writeJson(response, 200, state);
      });
      return;
    }
    if (request.method === "POST" && action === "snapshots" && subAction === "restore") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tag?: string };
        restoredSnapshotTags.push(body.tag ?? "");
        writeJson(response, 200, state);
      });
      return;
    }
    if (request.method === "GET" && action === "console") {
      writeJson(response, 200, { consoleUrl: state.consoleUrl });
      return;
    }
    writeJson(response, 404, { error: { code: "not_found", message: "route not found" } });
  });
  await new Promise<void>((resolve) =>
    supervisorServer!.listen(supervisorPort, "127.0.0.1", resolve),
  );

  await mkdir(path.join(temporary, "vms"), { recursive: true });
  await writeFile(path.join(temporary, "supervisor-acl.token"), supervisorToken, { mode: 0o600 });
  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 9 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const projectA = await catalog.createProject({
    name: "Phase 9 Project A",
    description: "Shared VM project A",
  });
  const projectB = await catalog.createProject({
    name: "Phase 9 Project B",
    description: "Shared VM project B",
  });
  const sharedVm = await catalog.createVm({
    name: "Phase 9 Shared VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "shared"),
  });
  const autoVm = await catalog.createVm({
    name: "Phase 9 Auto VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "auto"),
  });
  const idleVm = await catalog.createVm({
    name: "Phase 9 Idle VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "idle"),
  });
  await catalog.bindVm({
    projectId: projectA.id,
    vmId: sharedVm.id,
    guestWorkspacePath: "/home/worker/project-a",
    isPrimary: true,
  });
  await catalog.bindVm({
    projectId: projectB.id,
    vmId: sharedVm.id,
    guestWorkspacePath: "/home/worker/project-b",
    isPrimary: true,
  });
  await catalog.bindVm({
    projectId: projectB.id,
    vmId: autoVm.id,
    guestWorkspacePath: "/home/worker/auto",
    isPrimary: false,
  });
  const now = new Date().toISOString();
  await seed.db
    .updateTable("images")
    .set({ verified_at: now })
    .where("id", "=", image.id)
    .execute();
  await seed.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy", last_started_at: now })
    .where("id", "=", sharedVm.id)
    .execute();
  await seed.db
    .updateTable("vm_instances")
    .set({ power_state: "stopped", guest_health: "unknown" })
    .where("id", "=", autoVm.id)
    .execute();
  await seed.db
    .updateTable("vm_instances")
    .set({
      power_state: "running",
      guest_health: "healthy",
      last_started_at: "2020-01-01T00:00:00.000Z",
    })
    .where("id", "=", idleVm.id)
    .execute();
  for (const vm of [sharedVm, autoVm, idleVm]) {
    await mkdir(vm.storageRoot, { recursive: true });
    await writeFile(path.join(vm.storageRoot, "guest-agent.token"), guestToken, { mode: 0o600 });
  }
  await seed.close();

  sharedVmId = sharedVm.id;
  autoVmId = autoVm.id;
  idleVmId = idleVm.id;
  projectAId = projectA.id;
  projectBId = projectB.id;
  states.set(sharedVm.id, fakeState(sharedVm.id, "running", guestPort));
  states.set(autoVm.id, fakeState(autoVm.id, "stopped", guestPort));
  states.set(idleVm.id, fakeState(idleVm.id, "running", guestPort));

  await startControlPlane();
  const migrated = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  const tables = migrated.sqlite
    .prepare("select name from sqlite_master where type = 'table'")
    .all() as Array<{ name: string }>;
  const names = tables.map((row) => row.name);
  for (const table of ["vm_snapshots", "project_backups", "project_backup_bindings"]) {
    assert.ok(names.includes(table), `missing ${table}`);
  }
  await migrated.close();
  const report = await api<ResourceReport>("/api/v1/resources");
  assert.equal(report.totalVmCount, 3);
  assert.equal(report.allocations.length, 3);
  assert.equal(report.autoStartPolicy, "manual");
  passed("真实控制平面应用阶段 9 迁移并提供资源报告", `running=${report.runningVmCount}`);

  await setResourcePolicy({
    softMemoryBudgetBytes: 2 * 1024 ** 3,
    autoStartPolicy: "when_needed",
  });
  const autoTask = await createTask(projectBId, autoVmId, "Phase 9 auto start task");
  const blocked = await api<ResourceReconcileResult>("/api/v1/resources/reconcile", {
    method: "POST",
  });
  assert.ok(blocked.waitingTaskIds.includes(autoTask.id));
  assert.equal((await taskOf(autoTask.id)).task.status, "waiting_resources");
  assert.ok(blocked.report.blockedAutoStarts.some((item) => item.vmId === autoVmId));
  assert.ok(!startCalls.includes(autoVmId));
  passed("资源不足时任务进入等待资源并发出通知", `task=${autoTask.id}`);

  await setResourcePolicy({
    softMemoryBudgetBytes: 6 * 1024 ** 3,
    autoStartPolicy: "when_needed",
  });
  const started = await api<ResourceReconcileResult>("/api/v1/resources/reconcile", {
    method: "POST",
  });
  assert.ok(started.startedVmIds.includes(autoVmId));
  assert.equal((await taskOf(autoTask.id)).task.status, "queued");
  assert.ok(startCalls.includes(autoVmId));
  passed("预算足够后自动启动 VM 并将等待任务放回队列", `vm=${autoVmId}`);

  const sharedTask = await createTask(projectAId, sharedVmId, "Phase 9 shared queue task");
  const board = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  const boardTask = board.tasks.find((task) => task.id === sharedTask.id);
  assert.equal(boardTask?.vmPowerState, "running");
  assert.ok(board.resources);
  const sharedView = await vmView(sharedVmId);
  assert.ok(sharedView.queue.some((item) => item.taskId === sharedTask.id));
  assert.equal(sharedView.sharing.projectCount, 2);
  assert.ok(sharedView.sharing.warning);
  const projectDetail = await api<ProjectDetail>(`/api/v1/projects/${projectAId}`);
  const sharedBinding = projectDetail.bindings.find((item) => item.vm.id === sharedVmId);
  assert.ok((sharedBinding?.queueDepth ?? 0) >= 1);
  assert.equal(projectDetail.activeWorkerCount, 0);
  assert.ok(Array.isArray(sharedBinding?.activeWorkers));
  passed("看板、VM 页和项目页共享同一任务与 VM 状态", `task=${sharedTask.id}`);

  await api(`/api/v1/tasks/${sharedTask.id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "phase9 smoke" }),
  });
  await api(`/api/v1/vms/${sharedVmId}/stop`, {
    method: "POST",
    body: JSON.stringify({ mode: "graceful" }),
  });
  const snapshot = await api<VmSnapshotRecord>(`/api/v1/vms/${sharedVmId}/snapshots`, {
    method: "POST",
    body: JSON.stringify({ label: "shared snapshot" }),
  });
  const impact = await api<VmSnapshotImpact>(
    `/api/v1/vms/${sharedVmId}/snapshots/${snapshot.id}/impact`,
  );
  assert.equal(impact.affectedProjects.length, 2);
  assert.equal(impact.requiresConfirmation, true);
  await expectConflict(`/api/v1/vms/${sharedVmId}/snapshots/${snapshot.id}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const restored = await api<VmSnapshotImpact>(
    `/api/v1/vms/${sharedVmId}/snapshots/${snapshot.id}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ confirmSharedImpact: true }),
    },
  );
  assert.equal(restored.blocked, false);
  assert.ok(snapshotTags.length === 1);
  assert.ok(restoredSnapshotTags.length === 1);
  passed(
    "共享 VM 快照恢复前列出全部受影响项目并要求确认",
    impact.affectedProjects.map((project) => project.name).join("、"),
  );

  await api(`/api/v1/vms/${sharedVmId}/start`, { method: "POST", body: JSON.stringify({}) });
  const backup = await api<ProjectBackupRecord>(`/api/v1/projects/${projectAId}/backups`, {
    method: "POST",
    body: JSON.stringify({ label: "project A backup" }),
  });
  assert.equal(backup.status, "available");
  assert.equal(backup.bindings.length, 1);
  assert.match(backup.bindings[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const backupImpact = await api<{
    blocked: boolean;
    otherProjects: Array<{ name: string }>;
  }>(`/api/v1/projects/${projectAId}/backups/${backup.id}/impact`);
  assert.equal(backupImpact.blocked, false);
  assert.ok(backupImpact.otherProjects.some((project) => project.name === "Phase 9 Project B"));
  const verified = await api<{ ok: boolean }>(
    `/api/v1/projects/${projectAId}/backups/${backup.id}/verify`,
    { method: "POST" },
  );
  assert.equal(verified.ok, true);
  await api(`/api/v1/projects/${projectAId}/backups/${backup.id}/restore`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  assert.deepEqual(restoredWorkspaces, ["/home/worker/project-a"]);
  passed("项目级备份独立校验和恢复，不覆盖共享 VM 的其他项目目录");

  await expectConflict(`/api/v1/vms/${autoVmId}`, { method: "DELETE" });
  const disposable = await api<VmInstanceView>("/api/v1/vms", {
    method: "POST",
    body: JSON.stringify({
      name: "Phase 9 Disposable VM",
      imageId: image.id,
      cpuCount: 1,
      memoryGb: 1,
      diskGb: 1,
    }),
  });
  states.set(disposable.vm.id, fakeState(disposable.vm.id, "stopped", guestPort));
  await api(`/api/v1/vms/${disposable.vm.id}`, { method: "DELETE" });
  assert.ok(deletedVmIds.includes(disposable.vm.id));
  passed("VM 删除检查任务与绑定依赖，仅删除无依赖 stopped VM");

  await setResourcePolicy({
    idleSuspendEnabled: true,
    idleSuspendTimeoutMs: 5 * 60_000,
  });
  const idleResult = await api<ResourceReconcileResult>("/api/v1/resources/reconcile", {
    method: "POST",
  });
  assert.ok(idleResult.suspendedVmIds.includes(idleVmId));
  assert.ok(!idleResult.suspendedVmIds.includes(autoVmId));
  assert.ok(suspendCalls.includes(idleVmId));
  assert.ok(!suspendCalls.includes(autoVmId));
  passed("空闲休眠只休眠无任务 VM，不停止仍有任务的 VM");

  await expectConflict(`/api/v1/projects/${projectAId}`, { method: "DELETE" });
  const disposableProject = await api<ProjectDetail>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Phase 9 Disposable Project" }),
  });
  await api(`/api/v1/projects/${disposableProject.project.id}`, { method: "DELETE" });
  passed("项目删除检查任务和 Worker 历史依赖");

  const finalBoard = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  const finalAuto = finalBoard.tasks.find((task) => task.id === autoTask.id);
  const finalShared = finalBoard.tasks.find((task) => task.id === sharedTask.id);
  assert.equal(finalAuto?.status, "queued");
  assert.equal(finalShared?.status, "cancelled");
  assert.equal(finalBoard.projects.length >= 2, true);
  passed("断线重连式全量快照从数据库重建任务状态", `cursor=${finalBoard.eventCursor}`);
} catch (error) {
  console.error("phase9 smoke failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await stopChild(controlPlane);
  if (guestServer) await new Promise<void>((resolve) => guestServer!.close(() => resolve()));
  if (supervisorServer)
    await new Promise<void>((resolve) => supervisorServer!.close(() => resolve()));
  const result = {
    phase: 9,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: checks.length > 0 && checks.every((check) => check.passed) && !process.exitCode,
    checks,
    environment: {
      realControlPlane: true,
      realSqlite: true,
      realHostMemoryCounters: true,
      fakeSupervisor: true,
      fakeGuestAgent: true,
      realQemuWxpx: false,
      realLinuxGuest: false,
      realWorkerPi: false,
      realRouterPi: false,
      realModel: false,
      browserElectronUi: false,
    },
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  console.log(`phase9 smoke result written to ${resultPath}`);
  if (process.exitCode) process.exit(1);
}
