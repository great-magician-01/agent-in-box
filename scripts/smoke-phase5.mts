import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ConversationRecord,
  ProjectBindingView,
  ProjectDetail,
  TaskBoardSnapshot,
  TaskCreateResult,
  TaskDetail,
  TaskRecord,
  VmInstanceRecord,
  VmProjectReference,
} from "@agent-in-box/protocol";

interface StreamMessage {
  type?: string;
  topic?: string;
  taskId?: string;
  projectId?: string;
  eventVersion?: number;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase5-"));
const children: ChildProcess[] = [];
const sockets = new Set<import("ws").WebSocket>();
const checks: string[] = [];
const startedAt = new Date().toISOString();
const controlPlanePort = await freePort();
let workerDatabase: { close(): Promise<void> } | null = null;

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
  let done = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    done = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  }
  if (!done) throw new Error(`Control plane ${child.pid} did not exit`);
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${controlPlanePort}${route}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

async function expectHttpStatus(
  route: string,
  status: number,
  init: RequestInit = {},
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${controlPlanePort}${route}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  await response.arrayBuffer();
  assert.equal(response.status, status, `${route} returned unexpected HTTP status`);
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000),
    ),
  ]);
}

async function startControlPlane(): Promise<void> {
  const child = spawn(
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
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  children.push(child);
  await waitForHealth();
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );
  const { TaskRepository } = await import(dist("persistence/repositories/task-repository.js"));
  const { OutboxRepository } = await import(dist("persistence/repositories/outbox-repository.js"));
  const { TaskService } = await import(dist("persistence/services/task-service.js"));
  const { WebSocket } = await import(
    pathToFileURL(path.join(repository, "services/control-plane/node_modules/ws/wrapper.mjs")).href
  );

  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 5 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const runningVm = await catalog.createVm({
    name: "Shared running VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "running"),
  });
  const stoppedVm = await catalog.createVm({
    name: "Stopped bindable VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "stopped"),
  });
  await seed.db
    .updateTable("vm_instances")
    .set({
      power_state: "running",
      guest_health: "healthy",
      last_started_at: new Date().toISOString(),
    })
    .where("id", "=", runningVm.id)
    .execute();
  await seed.close();

  const openWorker = async () => {
    const database = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
    await database.migrate();
    workerDatabase = database;
    return {
      database,
      service: new TaskService(
        database.db,
        new TaskRepository(database.db),
        new OutboxRepository(database.db),
        { artifactRoot: path.join(temporary, "artifacts") },
      ),
    };
  };
  const closeWorker = async () => {
    if (workerDatabase) await workerDatabase.close();
    workerDatabase = null;
  };

  await mkdir(path.join(temporary, "artifacts", "evidence"), { recursive: true });
  await startControlPlane();
  passed("真实控制平面启动并应用阶段 5 SQLite 迁移");

  const projectA = await api<ProjectDetail>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "Project Alpha",
      workspaceConfig: { defaultGuestWorkspacePath: "/home/worker/alpha" },
    }),
  });
  const projectB = await api<ProjectDetail>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Project Beta" }),
  });
  await api(`/api/v1/projects/${projectA.project.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({
      vmId: runningVm.id,
      guestWorkspacePath: "/home/worker/alpha",
      isPrimary: true,
    }),
  });
  const twoBindings = await api<ProjectDetail>(`/api/v1/projects/${projectA.project.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ vmId: stoppedVm.id, guestWorkspacePath: "/home/worker/alpha-stopped" }),
  });
  assert.equal(twoBindings.bindings.length, 2);
  assert.equal(
    twoBindings.bindings.filter((item: ProjectBindingView) => item.binding.isPrimary).length,
    1,
  );
  await api(`/api/v1/projects/${projectB.project.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ vmId: runningVm.id, guestWorkspacePath: "/home/worker/beta" }),
  });
  const sharedDetail = await api<ProjectDetail>(`/api/v1/projects/${projectA.project.id}`);
  const shared = sharedDetail.bindings.find(
    (item: ProjectBindingView) => item.vm.id === runningVm.id,
  );
  assert.ok(shared);
  assert.deepEqual(
    new Set(shared.sharedProjects.map((item: VmProjectReference) => item.name)),
    new Set(["Project Alpha", "Project Beta"]),
  );
  await expectHttpStatus(`/api/v1/projects/${projectA.project.id}`, 400, {
    method: "PATCH",
    body: JSON.stringify({ workspaceConfig: null }),
  });
  await expectHttpStatus(`/api/v1/projects/${projectA.project.id}`, 400, {
    method: "PATCH",
    body: JSON.stringify({ workspaceConfig: {} }),
  });
  assert.equal(
    (await api<ProjectDetail>(`/api/v1/projects/${projectA.project.id}`)).project.workspaceConfig
      .defaultGuestWorkspacePath,
    "/home/worker/alpha",
  );
  passed("多项目共享同一 VM、单项目绑定多 VM、停止 VM 绑定及共享影响清单");

  const disposable = await api<ProjectDetail>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Disposable" }),
  });
  await api(`/api/v1/projects/${disposable.project.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ vmId: runningVm.id, guestWorkspacePath: "/home/worker/disposable" }),
  });
  await api(`/api/v1/projects/${disposable.project.id}`, { method: "DELETE" });
  const afterDelete = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  assert.ok(afterDelete.vms.some((vm: VmInstanceRecord) => vm.id === runningVm.id));
  passed("删除项目不会删除共享 VM");

  const conversation = await api<ConversationRecord>(
    `/api/v1/projects/${projectA.project.id}/conversations`,
    {
      method: "POST",
      body: JSON.stringify({ title: "Alpha source conversation" }),
    },
  );
  const streamMessages: StreamMessage[] = [];
  const stream = new WebSocket(`ws://127.0.0.1:${controlPlanePort}/api/v1/events/ws`, {
    origin: `http://127.0.0.1:${controlPlanePort}`,
  });
  sockets.add(stream);
  stream.on("message", (data: Buffer) => streamMessages.push(JSON.parse(String(data))));
  await once(stream, "open");
  await waitFor(() => streamMessages.some((event) => event.type === "ready"), "event stream ready");
  const unknownUpgrade = new WebSocket(`ws://127.0.0.1:${controlPlanePort}/api/v1/unknown/ws`);
  sockets.add(unknownUpgrade);
  const [upgradeError] = (await withTimeout(
    once(unknownUpgrade, "error"),
    "unknown upgrade rejection",
  )) as [Error];
  assert.match(upgradeError.message, /404/);

  const createTask = async (body: Record<string, unknown>, key: string) =>
    api<TaskCreateResult>("/api/v1/tasks", {
      method: "POST",
      headers: { "x-idempotency-key": key },
      body: JSON.stringify(body),
    });
  const low = await createTask(
    {
      projectId: projectA.project.id,
      vmId: runningVm.id,
      originConversationId: conversation.id,
      objective: "Low priority task",
    },
    "phase5-low",
  );
  const duplicate = await createTask(
    {
      projectId: projectA.project.id,
      vmId: runningVm.id,
      originConversationId: conversation.id,
      objective: "Low priority task",
    },
    "phase5-low",
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, low.task.id);
  await expectHttpStatus("/api/v1/tasks", 409, {
    method: "POST",
    headers: { "x-idempotency-key": "phase5-low" },
    body: JSON.stringify({
      projectId: projectA.project.id,
      vmId: runningVm.id,
      objective: "Changed request",
    }),
  });
  const high = await createTask(
    {
      projectId: projectB.project.id,
      vmId: runningVm.id,
      objective: "High priority cross-project task",
      priority: 50,
    },
    "phase5-high",
  );
  const dependent = await createTask(
    {
      projectId: projectA.project.id,
      vmId: runningVm.id,
      objective: "Dependent task",
      dependsOn: [low.task.id],
    },
    "phase5-dependent",
  );
  const waiting = await createTask(
    { projectId: projectA.project.id, vmId: stoppedVm.id, objective: "Stopped VM task" },
    "phase5-waiting",
  );
  assert.equal(low.task.status, "queued");
  assert.equal(dependent.task.status, "created");
  assert.equal(waiting.task.status, "waiting_vm");
  const ordered = await api<TaskBoardSnapshot>(
    `/api/v1/tasks/board?vmId=${encodeURIComponent(runningVm.id)}`,
  );
  assert.equal(ordered.tasks.find((task) => task.id === high.task.id).queuePosition, 1);
  assert.equal(ordered.tasks.find((task) => task.id === low.task.id).queuePosition, 2);
  await waitFor(
    () =>
      streamMessages.some(
        (event) => event.topic === "task.created" && event.taskId === high.task.id,
      ),
    "task.created WebSocket event",
  );
  const streamed = streamMessages.find(
    (event) => event.topic === "task.created" && event.taskId === high.task.id,
  );
  assert.equal(streamed.projectId, projectB.project.id);
  assert.equal(streamed.eventVersion, 1);
  passed("幂等创建、依赖、等待 VM、跨项目优先级队列和版本化 WebSocket 事件");

  let worker = await openWorker();
  const claimed = await worker.service.claimNext(runningVm.id);
  assert.equal(claimed.id, high.task.id);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(await worker.service.claimNext(runningVm.id), null);
  await closeWorker();
  passed("服务端 Worker 按优先级认领后，同 VM 第二个认领请求被拒绝");

  await expectHttpStatus(`/api/v1/tasks/${high.task.id}/complete`, 404, {
    method: "POST",
    body: JSON.stringify({ summary: "forged browser completion" }),
  });
  await stopChild(children.at(-1));
  await startControlPlane();
  worker = await openWorker();
  assert.equal(await worker.service.claimNext(runningVm.id), null);
  const afterRestart = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  assert.equal(afterRestart.tasks.find((task) => task.id === high.task.id).status, "running");
  assert.equal(afterRestart.tasks.find((task) => task.id === high.task.id).attemptCount, 1);
  passed("控制平面真实重启后运行中任务不重复认领，且浏览器无完成路由");

  const artifactBytes = Buffer.from("phase 5 verified evidence\n");
  await writeFile(path.join(temporary, "artifacts", "evidence", "result.txt"), artifactBytes);
  await assert.rejects(
    worker.service.complete(high.task.id, {
      summary: "bad artifact",
      artifacts: [{ relativePath: "evidence/result.txt", sha256: "0".repeat(64) }],
    }),
    /SHA-256/,
  );
  assert.equal((await worker.service.get(high.task.id)).status, "running");
  const completed = await worker.service.complete(high.task.id, {
    summary: "Cross-project task verified",
    result: { evidence: "sha256" },
    artifacts: [
      {
        relativePath: "evidence/result.txt",
        sha256: createHash("sha256").update(artifactBytes).digest("hex"),
        sizeBytes: artifactBytes.length,
        mediaType: "text/plain",
      },
    ],
  });
  assert.equal(completed.status, "completed");
  const completionDetail = await api<TaskDetail>(`/api/v1/tasks/${high.task.id}`);
  assert.equal(completionDetail.artifacts.length, 1);
  assert.ok(completionDetail.artifacts[0]?.verifiedAt);
  assert.deepEqual(completionDetail.task.result, { evidence: "sha256" });
  const eventCount = completionDetail.events.length;
  await expectHttpStatus(
    `/api/v1/tasks/${waiting.task.id}/artifacts/${completionDetail.artifacts[0]!.id}/verify`,
    404,
    { method: "POST" },
  );
  assert.equal((await api<TaskDetail>(`/api/v1/tasks/${high.task.id}`)).events.length, eventCount);
  await api(`/api/v1/tasks/${high.task.id}/artifacts/${completionDetail.artifacts[0]!.id}/verify`, {
    method: "POST",
  });
  passed("错误产物哈希阻止完成，正确结果/产物通过独立校验并进入时间线");

  assert.equal((await worker.service.claimNext(runningVm.id)).id, low.task.id);
  await worker.service.complete(low.task.id, { summary: "Dependency completed" });
  assert.equal((await worker.service.get(dependent.task.id)).status, "queued");
  assert.equal((await worker.service.claimNext(runningVm.id)).id, dependent.task.id);
  await worker.service.fail(
    dependent.task.id,
    "synthetic_worker_failure",
    "Synthetic failure for retry validation",
  );
  const retried = await api<TaskRecord>(`/api/v1/tasks/${dependent.task.id}/retry`, {
    method: "POST",
  });
  assert.equal(retried.status, "queued");
  assert.equal(retried.errorCode, null);
  await api(`/api/v1/tasks/${waiting.task.id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "Smoke cancellation" }),
  });
  assert.equal(
    (await api<TaskDetail>(`/api/v1/tasks/${waiting.task.id}`)).task.status,
    "cancelled",
  );
  await closeWorker();
  passed("依赖完成后唤醒、失败错误记录、HTTP 重试和取消均保持合法状态迁移");

  await expectHttpStatus(`/api/v1/projects/${projectA.project.id}/archive`, 409, {
    method: "POST",
  });
  await api(`/api/v1/projects/${projectB.project.id}/archive`, { method: "POST" });
  const betaBinding = (await api<ProjectDetail>(`/api/v1/projects/${projectB.project.id}`))
    .bindings[0]!;
  await expectHttpStatus(
    `/api/v1/projects/${projectB.project.id}/bindings/${betaBinding.binding.id}`,
    409,
    { method: "DELETE" },
  );
  await api(`/api/v1/projects/${projectB.project.id}/restore`, { method: "POST" });
  await api(`/api/v1/projects/${projectB.project.id}/bindings/${betaBinding.binding.id}`, {
    method: "DELETE",
  });
  assert.ok(
    (await api<TaskBoardSnapshot>("/api/v1/tasks/board")).vms.some(
      (vm: VmInstanceRecord) => vm.id === runningVm.id,
    ),
  );
  passed("活跃项目归档保护、归档修改保护和解绑不删除 VM");

  console.log(`Phase 5 smoke: interrupting event stream (state ${stream.readyState})`);
  if (stream.readyState !== WebSocket.CLOSED) {
    const closed = once(stream, "close");
    stream.terminate();
    await withTimeout(closed, "event stream disconnect");
  }
  await createTask(
    {
      projectId: projectA.project.id,
      vmId: stoppedVm.id,
      objective: "Created while stream offline",
    },
    "phase5-offline",
  );
  const reconnected = new WebSocket(`ws://127.0.0.1:${controlPlanePort}/api/v1/events/ws`);
  sockets.add(reconnected);
  await withTimeout(once(reconnected, "open"), "event stream reconnect");
  console.log("Phase 5 smoke: event stream reconnected");
  const fullSnapshot = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  assert.ok(fullSnapshot.tasks.some((task) => task.objective === "Created while stream offline"));
  assert.ok(
    fullSnapshot.tasks.some((task) => task.id === high.task.id && task.status === "completed"),
  );
  assert.ok(fullSnapshot.eventCursor > 0);
  passed("WebSocket 断线期间不依赖增量重放，重连后完整数据库快照包含全部任务");

  const result = {
    phase: 5,
    startedAt,
    completedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    checks,
    realQemuValidated: false,
    browserInteractionValidated: false,
    workerRuntimeIntegrated: false,
    note: "Real control-plane HTTP/WebSocket processes plus an in-process server-side TaskService worker driver. No Pi Worker, QEMU/WHPX or browser/Electron interaction is claimed.",
  };
  const resultPath =
    process.env.AGENT_IN_BOX_PHASE5_RESULT ??
    path.join(repository, "tests/phase5/results/2026-11-11-smoke.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Phase 5 smoke result: ${resultPath}`);
} finally {
  if (workerDatabase) await workerDatabase.close();
  for (const socket of sockets) socket.terminate();
  await Promise.allSettled(children.reverse().map((child) => stopChild(child)));
  await rm(temporary, { recursive: true, force: true });
}
