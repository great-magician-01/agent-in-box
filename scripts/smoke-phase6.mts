import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ConversationMessageRecord,
  ModelRequestRecord,
  TaskDetail,
  WorkerView,
} from "@agent-in-box/protocol";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../services/control-plane/src/persistence/schema";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase6-"));
const resultPath =
  process.env.AGENT_IN_BOX_PHASE6_RESULT?.trim() ||
  path.join(repository, "tests/phase6/results", `${new Date().toISOString().slice(0, 10)}-smoke.json`);
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const controlPlanePort = await freePort();
const supervisorPort = await freePort();
const brokerPort = await freePort();
const upstreamPort = await freePort();
const startedAt = new Date().toISOString();
const workerRpcToken = "phase6-worker-rpc-token";
const rotatedWorkerRpcToken = "phase6-worker-rpc-token-rotated";
const upstreamSecret = "phase6-upstream-secret-not-in-guest";
const credentialsPath = path.join(temporary, "model-credentials.json");
const supervisorTokenPath = path.join(temporary, "supervisor-acl.token");
const commandLog = path.join(temporary, "fake-pi-commands.jsonl");
let controlPlane: ChildProcess | undefined;
let guestServer: { close(): Promise<void> } | undefined;
let supervisorServer: import("node:http").Server | undefined;
let upstreamServer: import("node:http").Server | undefined;
let smokeDatabase: { db: Kysely<DatabaseSchema>; close(): Promise<void> } | undefined;
let vmId = "";
let projectId = "";
let workerId = "";
let upstreamRequests = 0;

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

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(100);
  }
}

async function stopChild(child: ChildProcess | undefined, timeoutMs = 15_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const done = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${controlPlanePort}${route}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
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
        AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: supervisorTokenPath,
        AGENT_IN_BOX_MODEL_BROKER_PORT: String(brokerPort),
        AGENT_IN_BOX_MODEL_BROKER_GUEST_URL: `http://127.0.0.1:${brokerPort}`,
        AGENT_IN_BOX_MODEL_CREDENTIALS_FILE: credentialsPath,
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
      const response = await fetch(`http://127.0.0.1:${controlPlanePort}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Control plane did not become healthy");
}

function modelsPath(): string {
  return path.join(temporary, "guest-sessions", workerId, "home", ".pi", "agent", "models.json");
}

async function worker(): Promise<WorkerView> {
  return api<WorkerView>(`/api/v1/workers/${workerId}`);
}

async function task(taskId: string): Promise<TaskDetail> {
  return api<TaskDetail>(`/api/v1/tasks/${taskId}`);
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(dist("persistence/repositories/catalog-repository.js"));
  const { ModelTokenService } = await import(dist("models/model-token.service.js"));
  const { PiWorkerEngine, WorkerRpcServer } = await import(
    pathToFileURL(path.join(repository, "packages/agent-runtime/dist/index.js")).href
  );
  const fakePi = path.join(repository, "packages/agent-runtime/src/testing/fake-pi.mjs");

  await mkdir(path.join(temporary, "vms"), { recursive: true });
  await writeFile(credentialsPath, JSON.stringify({ mock: upstreamSecret }), { mode: 0o600 });
  await writeFile(supervisorTokenPath, "phase6-supervisor-token", { mode: 0o600 });
  await writeFile(commandLog, "");

  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 6 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const project = await catalog.createProject({
    name: "Phase 6 Worker project",
    description: "Phase 6 smoke project",
  });
  const vm = await catalog.createVm({
    name: "Phase 6 Worker VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "phase6-vm"),
  });
  const conversation = await catalog.createConversation({
    kind: "project",
    projectId: project.id,
    title: "Phase 6 Worker conversation",
  });
  const workspacePath = path.join(temporary, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await catalog.bindVm({
    projectId: project.id,
    vmId: vm.id,
    guestWorkspacePath: workspacePath,
    isPrimary: true,
  });
  await seed.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy", last_started_at: new Date().toISOString() })
    .where("id", "=", vm.id)
    .execute();
  await mkdir(vm.storageRoot, { recursive: true });
  await writeFile(path.join(vm.storageRoot, "worker-rpc.token"), workerRpcToken, { mode: 0o600 });
  await seed.close();
  vmId = vm.id;
  projectId = project.id;

  const guestEngine = new PiWorkerEngine({
    sessionRoot: path.join(temporary, "guest-sessions"),
    piBinary: process.execPath,
    argsPrefix: [fakePi],
    env: { ...process.env, FAKE_PI_COMMAND_LOG: commandLog },
  });
  const workerServer = new WorkerRpcServer({
    engine: guestEngine,
    tokenFile: path.join(vm.storageRoot, "worker-rpc.token"),
    host: "127.0.0.1",
    port: 0,
  });
  const listening = await workerServer.start();
  guestServer = workerServer;
  const workerPort = listening.port;

  const supervisorState = {
    id: vm.id,
    powerState: "running",
    pid: 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: 0,
    workerHostPort: workerPort,
    consoleUrl: "vnc://127.0.0.1:5901",
    diskPath: path.join(vm.storageRoot, "disk.qcow2"),
    guestHealth: "healthy",
    lastError: "",
    updatedAt: new Date().toISOString(),
  };
  const supervisor = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer phase6-supervisor-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid token" } }));
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    if (url.pathname === `/api/v1/vms/${vm.id}`) {
      response.end(JSON.stringify(supervisorState));
    } else if (url.pathname === "/api/v1/vms") {
      response.end(JSON.stringify({ items: [supervisorState] }));
    } else {
      response.writeHead(404).end();
    }
  });
  supervisor.listen(supervisorPort, "127.0.0.1");
  await once(supervisor, "listening");
  supervisorServer = supervisor;

  const upstream = createServer((request, response) => {
    upstreamRequests += 1;
    if (request.url !== "/v1/chat/completions" || request.headers.authorization !== `Bearer ${upstreamSecret}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad upstream auth" } }));
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-phase6",
        choices: [{ index: 0, delta: { content: "hello from upstream" } }],
        usage: { prompt_tokens: 17, completion_tokens: 5 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");
  upstreamServer = upstream;

  smokeDatabase = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await smokeDatabase.migrate();

  await startControlPlane();
  passed("真实控制平面应用阶段 6 SQLite 迁移并启动 Model Broker");

  await api("/api/v1/models/providers/mock", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      api: "openai-completions",
      credentialProviderId: "mock",
      models: [{ id: "mock-cua", name: "Mock Computer Use", reasoning: false }],
      enabled: true,
    }),
  });
  const created = await api<WorkerView>("/api/v1/workers", {
    method: "POST",
    body: JSON.stringify({ projectId, vmId, conversationId: conversation.id }),
  });
  workerId = created.worker.id;
  assert.equal(created.runtime.connected, true);
  assert.equal(created.worker.status, "idle");
  assert.equal(created.worker.engineVersion, "1.5.1");
  assert.equal(created.worker.sessionVersion, "1");
  passed("Worker 通过 Guest RPC 握手并建立 Pi 会话", `worker=${workerId}`);

  const models = JSON.parse(await readFile(modelsPath(), "utf8")) as {
    providers: Record<string, { apiKey?: string; models?: Array<{ id?: string }> }>;
  };
  const brokerToken = models.providers.mock?.apiKey;
  assert.equal(typeof brokerToken, "string");
  assert.notEqual(brokerToken, upstreamSecret);
  assert.equal(models.providers.mock?.models?.[0]?.id, "mock-cua");
  const tokenRows = await smokeDatabase.db
    .selectFrom("model_tokens")
    .selectAll()
    .where("worker_id", "=", workerId)
    .execute();
  assert.equal(tokenRows.length, 1);
  assert.equal(
    createHash("sha256").update(brokerToken as string).digest("hex"),
    (tokenRows[0] as { token_hash: string }).token_hash,
  );
  const guestModels = await readFile(modelsPath(), "utf8");
  assert.equal(guestModels.includes(upstreamSecret), false);
  passed("Guest 只持有短期 Broker 令牌，镜像/会话文件中没有长期 Provider Key");

  const quick = await api<{ taskId: string }>(`/api/v1/workers/${workerId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: "Quick desktop check" }),
  });
  await waitFor(async () => (await task(quick.taskId)).task.status === "blocked", "quick task blocked");
  const quickDetail = await task(quick.taskId);
  assert.equal(quickDetail.task.errorCode, "awaiting_verification");
  assert.equal(quickDetail.task.assignedWorkerId, workerId);
  assert.deepEqual(
    quickDetail.events.map((event) => event.type).filter((type) => type.startsWith("worker.")),
    ["worker.turn_started", "worker.tool_started", "worker.tool_finished", "worker.turn_finished"],
  );
  const messages = await api<ConversationMessageRecord[]>(`/api/v1/workers/${workerId}/messages`);
  assert.deepEqual(
    messages.map((message) => `${message.role}:${message.content}`),
    ["user:Quick desktop check", "assistant:working"],
  );
  assert.equal((await worker()).worker.status, "idle");
  const control = await api<{ state: string }>(`/api/v1/vms/${vmId}/control`);
  assert.equal(control.state, "idle");
  passed("Pi 事件映射为 TaskEvent/会话消息并释放 Execution Lease");

  const hold = await api<{ taskId: string }>(`/api/v1/workers/${workerId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: "[hold] Long desktop task" }),
  });
  await waitFor(async () => (await task(hold.taskId)).task.status === "running", "hold task running");
  const steered = await api<{ disposition: string; taskId: string }>(`/api/v1/workers/${workerId}/steer`, {
    method: "POST",
    body: JSON.stringify({ text: "Prefer the terminal" }),
  });
  assert.equal(steered.disposition, "queued");
  assert.equal(steered.taskId, hold.taskId);
  const beforeCancel = await task(hold.taskId);
  assert.ok(beforeCancel.events.some((event) => event.type === "worker.steer"));
  await api(`/api/v1/tasks/${hold.taskId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "Smoke cancel" }),
  });
  await waitFor(async () => (await task(hold.taskId)).task.status === "cancelled", "cancelled task");
  await waitFor(async () => (await worker()).worker.status === "idle", "worker idle after cancel");
  await waitFor(async () => {
    const log = await readFile(commandLog, "utf8");
    return log.trim().split("\n").some((line) => (JSON.parse(line) as { type: string }).type === "abort");
  }, "Pi RPC abort command");
  passed("Steer 与 Follow-up 区分，任务取消会触发 Pi Abort 并释放 Lease");

  const oldToken = workerRpcToken;
  await writeFile(path.join(vm.storageRoot, "worker-rpc.token"), rotatedWorkerRpcToken, { mode: 0o600 });
  const oldResponse = await fetch(`http://127.0.0.1:${workerPort}/v1/version`, {
    headers: { authorization: `Bearer ${oldToken}` },
  });
  assert.equal(oldResponse.status, 401);
  await oldResponse.arrayBuffer();
  const newResponse = await fetch(`http://127.0.0.1:${workerPort}/v1/version?protocolVersion=0.1.0`, {
    headers: { authorization: `Bearer ${rotatedWorkerRpcToken}` },
  });
  assert.equal(newResponse.status, 200);
  await newResponse.arrayBuffer();
  passed("Guest Worker RPC 令牌原子轮换后旧令牌立即失效");

  const tokenService = new ModelTokenService(smokeDatabase.db, { ttlMs: 60_000 });
  const issued = await tokenService.issue({
    workerId,
    vmId,
    sessionId: "smoke-broker-session",
    providerId: "mock",
    model: "mock-cua",
  });
  const brokerResponse = await fetch(`http://127.0.0.1:${brokerPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ model: "mock-cua", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(brokerResponse.status, 200);
  const streamed = await brokerResponse.text();
  assert.match(streamed, /hello from upstream/);
  await waitFor(async () => {
    const rows = await smokeDatabase!.db
      .selectFrom("model_requests")
      .selectAll()
      .where("worker_id", "=", workerId)
      .orderBy("created_at", "desc")
      .limit(1)
      .execute();
    const row = rows[0] as { status?: string; usage_json?: string | null } | undefined;
    return row?.status === "completed" && Boolean(row.usage_json);
  }, "broker usage record");
  const brokerRequests = await api<ModelRequestRecord[]>("/api/v1/models/requests?workerId=" + encodeURIComponent(workerId));
  assert.equal(brokerRequests[0]?.status, "completed");
  assert.equal(brokerRequests[0]?.usage?.inputTokens, 17);
  assert.equal(brokerRequests[0]?.usage?.outputTokens, 5);
  await tokenService.revoke(issued.context.id, "smoke_revoke");
  const revokedResponse = await fetch(`http://127.0.0.1:${brokerPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ model: "mock-cua", messages: [] }),
  });
  assert.equal(revokedResponse.status, 401);
  await revokedResponse.arrayBuffer();
  const upstreamKeyResponse = await fetch(`http://127.0.0.1:${brokerPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${upstreamSecret}` },
    body: JSON.stringify({ model: "mock-cua", messages: [] }),
  });
  assert.equal(upstreamKeyResponse.status, 401);
  await upstreamKeyResponse.arrayBuffer();
  passed("Model Broker 流式透传、用量记录，撤销令牌和长期 Key 均被拒绝");

  const restartTask = await api<{ taskId: string }>(`/api/v1/workers/${workerId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: "[hold] Cross-restart task" }),
  });
  await waitFor(async () => (await task(restartTask.taskId)).task.status === "running", "restart task running");
  await stopChild(controlPlane);
  assert.equal(upstreamRequests, 1);
  await startControlPlane();
  await waitFor(async () => (await worker()).worker.lastErrorCode === "control_plane_restarted", "worker restart reconcile");
  await waitFor(async () => (await task(restartTask.taskId)).task.errorCode === "worker_runtime_restarted", "task restart failure");
  assert.equal((await task(restartTask.taskId)).task.status, "failed");
  assert.notEqual((await worker()).worker.agentSessionRef, null);
  passed("控制平面重启不重复执行，Worker 绑定与会话引用保留");

  const resumedWorker = await api<WorkerView>(`/api/v1/workers/${workerId}/resume`, { method: "POST" });
  assert.equal(resumedWorker.runtime.connected, true);
  assert.equal(resumedWorker.worker.status, "idle");
  assert.ok(resumedWorker.worker.agentSessionRef);
  passed("Worker 通过持久会话引用 Native Resume 恢复");

  const archived = await api<WorkerView>(`/api/v1/workers/${workerId}/archive`, { method: "POST" });
  assert.equal(archived.worker.status, "archived");
  const restored = await api<WorkerView>(`/api/v1/workers/${workerId}/resume`, { method: "POST" });
  assert.equal(restored.worker.status, "idle");
  assert.equal(restored.runtime.connected, true);
  passed("Worker 会话归档与从归档恢复入口可用");

  const postResume = await api<{ taskId: string }>(`/api/v1/workers/${workerId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: "Post-resume check" }),
  });
  await waitFor(async () => (await task(postResume.taskId)).task.status === "blocked", "post-resume task");
  passed("恢复后的 Worker 可继续接收任务");
} catch (error) {
  checks.push({
    name: "phase6 smoke",
    passed: false,
    detail: error instanceof Error ? stackSummary(error) : String(error),
  });
  console.error("FAIL:", error);
  process.exitCode = 1;
} finally {
  await stopChild(controlPlane);
  await guestServer?.close().catch(() => undefined);
  if (smokeDatabase) await smokeDatabase.close().catch(() => undefined);
  await new Promise<void>((resolve) => supervisorServer?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => upstreamServer?.close(() => resolve()) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
  const finishedAt = new Date().toISOString();
  const result = {
    name: "agent-in-box-phase6-smoke",
    startedAt,
    finishedAt,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
    boundaries: {
      realChildProcess: true,
      realPiProcess: false,
      realModel: false,
      realQemuWxpx: false,
      browserElectronUi: false,
      workerGuestIsFakePi: true,
    },
    upstreamRequests,
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ resultPath, status: result.status, checks: checks.length }));
}

function stackSummary(error: Error): string {
  return (error.stack ?? error.message).split("\n").slice(0, 8).join("\n");
}
