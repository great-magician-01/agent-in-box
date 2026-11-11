import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { smokeAuthHeaders } from "./smoke-auth.mjs";
import type {
  CuaApprovalRecord,
  TaskDetail,
  TaskTraceView,
  WorkerView,
} from "@agent-in-box/protocol";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase7-"));
const configDirectory = path.join(temporary, "config");
const resultPath =
  process.env.AGENT_IN_BOX_PHASE7_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase7/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const controlPlanePort = await freePort();
const supervisorPort = await freePort();
const modelBrokerPort = await freePort();
const cuaBrokerPort = await freePort();
const workerRpcToken = "phase7-worker-rpc-token";
const guestToken = "phase7-guest-token";
const commandLog = path.join(temporary, "fake-pi-commands.jsonl");
const envLog = path.join(temporary, "fake-pi-env.json");
const startedAt = new Date().toISOString();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BGDs0ABwABf/9WlFTKAAAAAElFTkSuQmCC",
  "base64",
);
let controlPlane: ChildProcess | undefined;
let workerServer: { close(): Promise<void> } | undefined;
let supervisorServer: Server | undefined;
let guestServer: Server | undefined;
let fakeDisplay = { width: 1280, height: 720, dpi: 96, scaleFactor: 1 };
let advanceScreen = true;
let screenshotCounter = 0;
const inputCalls: Array<Record<string, unknown>> = [];
const verifyCalls: Array<Record<string, unknown>> = [];
let verifyOk = true;
let vmId = "";
let projectId = "";
let workerId = "";
let workerCuaToken = "";
const watchdog = setTimeout(() => {
  console.error(`phase7 smoke watchdog timeout after ${checks.length} checks`);
  for (const child of children) child.kill("SIGKILL");
  process.exit(2);
}, 180_000);

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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeout = 25_000,
): Promise<void> {
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
  const done = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
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
      ...smokeAuthHeaders(configDirectory),
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
        AGENT_IN_BOX_CONFIG_DIR: configDirectory,
        AGENT_IN_BOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisorPort}`,
        AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: path.join(temporary, "supervisor-acl.token"),
        AGENT_IN_BOX_MODEL_BROKER_PORT: String(modelBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_PORT: String(cuaBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_GUEST_URL: `http://127.0.0.1:${cuaBrokerPort}`,
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
      if (response.ok) {
        const broker = await fetch(`http://127.0.0.1:${cuaBrokerPort}/healthz`, {
          signal: AbortSignal.timeout(1000),
        });
        if (broker.ok) return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Control plane or Computer Use Broker did not become healthy");
}

function task(taskId: string): Promise<TaskDetail> {
  return api<TaskDetail>(`/api/v1/tasks/${taskId}`);
}

function worker(): Promise<WorkerView> {
  return api<WorkerView>(`/api/v1/workers/${workerId}`);
}

async function broker(pathName: string, body: unknown, timeoutMs = 30_000): Promise<Response> {
  assert.ok(workerCuaToken, "Worker Computer Use token is available");
  return fetch(`http://127.0.0.1:${cuaBrokerPort}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerCuaToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function brokerJson<T>(pathName: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const response = await broker(pathName, body, timeoutMs);
  const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
  assert.equal(response.status, 200, `broker ${pathName}: ${JSON.stringify(payload)}`);
  return payload as T;
}

async function newRunningTask(text = "[hold] Phase 7 desktop task"): Promise<string> {
  const prompted = await api<{ taskId: string }>(`/api/v1/workers/${workerId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  await waitFor(
    async () => (await task(prompted.taskId)).task.status === "running",
    "task running",
  );
  return prompted.taskId;
}

async function waitIdle(): Promise<void> {
  await waitFor(async () => (await worker()).worker.status === "idle", "worker idle");
}

async function endTask(taskId: string): Promise<void> {
  try {
    await api(`/api/v1/tasks/${taskId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "smoke cleanup" }),
    });
  } catch {
    // A blocked or completed task is already terminal.
  }
  await waitIdle();
}

async function waitingApproval(taskId: string): Promise<CuaApprovalRecord> {
  let approval: CuaApprovalRecord | undefined;
  await waitFor(async () => {
    const approvals = await api<CuaApprovalRecord[]>(`/api/v1/approvals?taskId=${taskId}`);
    approval = approvals.find((item) => item.status === "pending");
    return Boolean(approval);
  }, "pending approval");
  assert.ok(approval);
  return approval;
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );
  const { PiWorkerEngine, WorkerRpcServer } = await import(
    pathToFileURL(path.join(repository, "packages/agent-runtime/dist/index.js")).href
  );
  const fakePi = path.join(repository, "packages/agent-runtime/src/testing/fake-pi.mjs");

  await mkdir(path.join(temporary, "vms"), { recursive: true });
  await writeFile(path.join(temporary, "supervisor-acl.token"), "phase7-supervisor-token", {
    mode: 0o600,
  });
  await writeFile(commandLog, "");
  await writeFile(envLog, "{}");

  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 7 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const project = await catalog.createProject({
    name: "Phase 7 CUA project",
    description: "Phase 7 smoke project",
  });
  const vm = await catalog.createVm({
    name: "Phase 7 CUA VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "phase7-vm"),
  });
  const conversation = await catalog.createConversation({
    kind: "project",
    projectId: project.id,
    title: "Phase 7 CUA conversation",
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
    .set({
      power_state: "running",
      guest_health: "healthy",
      last_started_at: new Date().toISOString(),
    })
    .where("id", "=", vm.id)
    .execute();
  await mkdir(vm.storageRoot, { recursive: true });
  await writeFile(path.join(vm.storageRoot, "worker-rpc.token"), workerRpcToken, { mode: 0o600 });
  await writeFile(path.join(vm.storageRoot, "guest-agent.token"), guestToken, { mode: 0o600 });
  await seed.close();
  vmId = vm.id;
  projectId = project.id;

  const guest = createServer((request, response) => {
    void handleGuest(request, response).catch((error: unknown) => {
      console.error("fake guest request failed", error);
      if (!response.headersSent) writeJson(response, 500, { ok: false, error: String(error) });
      else response.end();
    });
  });
  await new Promise<void>((resolve) => guest.listen(0, "127.0.0.1", () => resolve()));
  guestServer = guest;
  const guestPort = (guest.address() as AddressInfo).port;

  const guestEngine = new PiWorkerEngine({
    sessionRoot: path.join(temporary, "guest-sessions"),
    piBinary: process.execPath,
    argsPrefix: [fakePi],
    env: {
      ...process.env,
      FAKE_PI_COMMAND_LOG: commandLog,
      FAKE_PI_ENV_LOG: envLog,
    },
  });
  const rpcServer = new WorkerRpcServer({
    engine: guestEngine,
    tokenFile: path.join(vm.storageRoot, "worker-rpc.token"),
    host: "127.0.0.1",
    port: 0,
  });
  const listening = await rpcServer.start();
  workerServer = rpcServer;
  const workerPort = listening.port;

  const supervisorState = {
    id: vm.id,
    powerState: "running",
    pid: 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: guestPort,
    workerHostPort: workerPort,
    consoleUrl: "vnc://127.0.0.1:5901",
    diskPath: path.join(vm.storageRoot, "disk.qcow2"),
    guestHealth: "healthy",
    lastError: "",
    updatedAt: new Date().toISOString(),
  };
  supervisorServer = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer phase7-supervisor-token") {
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
  await new Promise<void>((resolve) =>
    supervisorServer!.listen(supervisorPort, "127.0.0.1", resolve),
  );

  await startControlPlane();
  passed("真实控制平面应用阶段 7 迁移并启动 Computer Use Broker");

  await api("/api/v1/models/providers/mock", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: "https://models.example.test/v1",
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
  let piEnv: { cuaUrl?: string; cuaToken?: string } = {};
  await waitFor(async () => {
    try {
      piEnv = JSON.parse(await readFile(envLog, "utf8")) as {
        cuaUrl?: string;
        cuaToken?: string;
      };
    } catch {
      return false;
    }
    workerCuaToken = piEnv.cuaToken ?? "";
    return Boolean(workerCuaToken);
  }, "Worker Pi environment carries a Computer Use token");
  assert.equal(piEnv.cuaUrl, `http://127.0.0.1:${cuaBrokerPort}`);
  assert.equal(piEnv.cuaToken, workerCuaToken);
  assert.notEqual(workerCuaToken, workerRpcToken);
  passed("Guest Worker 会话收到短期 Computer Use Broker 令牌", `worker=${workerId}`);

  const unbound = await broker("/v1/observe", {});
  assert.equal(unbound.status, 409);
  await unbound.arrayBuffer();
  const unauthorized = await fetch(`http://127.0.0.1:${cuaBrokerPort}/v1/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  passed("Computer Use Broker 拒绝无令牌请求");

  const traceTaskId = await newRunningTask();
  const observation = await brokerJson<{
    screenshotId: string;
    width: number;
    height: number;
    image: { dataBase64: string };
  }>("/v1/observe", {});
  assert.equal(observation.width, 1280);
  const clickResponse = await broker("/v1/actions", {
    action: { type: "click", point: { x: 40, y: 30 } },
    screenshotId: observation.screenshotId,
  });
  assert.equal(clickResponse.status, 200);
  const click = (await clickResponse.json()) as { actionId: string; screenshotId: string };
  assert.match(click.actionId, /^[a-z0-9-]+$/i);
  assert.equal(inputCalls.length, 1);
  assert.equal(inputCalls[0]?.type, "click");
  assert.equal(inputCalls[0]?.leaseId, undefined); // Lease is host-side; Guest sees the resolved action only.
  const trace = await api<TaskTraceView>(`/api/v1/tasks/${traceTaskId}/trace`);
  assert.equal(trace.actions.length, 1);
  assert.equal(trace.actions[0]?.taskId, traceTaskId);
  assert.equal(trace.actions[0]?.workerId, workerId);
  assert.equal(trace.actions[0]?.status, "executed");
  assert.ok(trace.actions[0]?.leaseId);
  assert.ok(trace.screenshots.length >= 2);
  passed("动作经 Execution Lease 执行并审计到任务、Worker 和前后截图");

  const noObservation = await broker("/v1/actions", {
    action: { type: "click", point: { x: 10, y: 10 } },
  });
  assert.equal(noObservation.status, 409);
  await noObservation.arrayBuffer();
  const stale = await broker("/v1/actions", {
    action: { type: "click", point: { x: 12, y: 12 } },
    screenshotId: observation.screenshotId,
  });
  assert.equal(stale.status, 409);
  await stale.arrayBuffer();
  passed("无观察或无有效 Lease 的动作不会执行");

  fakeDisplay = { ...fakeDisplay, width: 1600, height: 900 };
  const changed = await broker("/v1/actions", {
    action: { type: "click", point: { x: 12, y: 12 } },
    screenshotId: click.screenshotId,
  });
  assert.equal(changed.status, 409);
  const changedBody = (await changed.json()) as { error?: { message?: string } };
  assert.match(changedBody.error?.message ?? "", /分辨率|观察/);
  fakeDisplay = { ...fakeDisplay, width: 1280, height: 720 };
  passed("分辨率变化使旧截图坐标失效并要求重新观察");

  await endTask(traceTaskId);

  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: ["type_text"], approvalTimeoutMs: 5000 }),
  });
  const approvalTaskId = await newRunningTask();
  const approvalObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const pendingApproval = broker("/v1/actions", {
    action: { type: "type_text", text: "中文输入", screenshotId: approvalObservation.screenshotId },
  });
  const approval = await waitingApproval(approvalTaskId);
  assert.equal((await task(approvalTaskId)).task.status, "waiting_approval");
  assert.equal(inputCalls.length, 1);
  await api(`/api/v1/approvals/${approval.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: "smoke approve" }),
  });
  const approvedResponse = await pendingApproval;
  assert.equal(approvedResponse.status, 200);
  const approvedBody = (await approvedResponse.json()) as { ok?: boolean };
  assert.equal(approvedBody.ok, true);
  assert.equal(inputCalls.length, 2);
  assert.equal(inputCalls[1]?.type, "type_text");
  assert.equal(inputCalls[1]?.text, "中文输入");
  passed("敏感动作在人工批准前不执行，批准后按存储的动作执行");

  await endTask(approvalTaskId);
  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: ["keypress"] }),
  });
  const rejectedTaskId = await newRunningTask();
  const rejectedObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const rejectedPending = broker("/v1/actions", {
    action: {
      type: "keypress",
      keys: ["ctrl", "s"],
      screenshotId: rejectedObservation.screenshotId,
    },
  });
  const rejectedApproval = await waitingApproval(rejectedTaskId);
  await api(`/api/v1/approvals/${rejectedApproval.id}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: "smoke reject" }),
  });
  const rejectedResponse = await rejectedPending;
  assert.equal(rejectedResponse.status, 403);
  await rejectedResponse.arrayBuffer();
  assert.equal(inputCalls.length, 2);
  const rejectedTrace = await api<TaskTraceView>(`/api/v1/tasks/${rejectedTaskId}/trace`);
  assert.equal(rejectedTrace.approvals[0]?.status, "rejected");
  const rejectedEvents = (await task(rejectedTaskId)).events.map((event) => event.type);
  assert.ok(rejectedEvents.includes("task.approval_resolved"));
  assert.equal((await task(rejectedTaskId)).task.status, "running");
  passed("拒绝审批后动作不执行并产生明确工具结果与任务事件");

  await endTask(rejectedTaskId);
  const cancelledTaskId = await newRunningTask();
  const cancelledObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const cancelledPending = broker("/v1/actions", {
    action: { type: "keypress", keys: ["enter"], screenshotId: cancelledObservation.screenshotId },
  });
  await waitingApproval(cancelledTaskId);
  await api(`/api/v1/tasks/${cancelledTaskId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "smoke cancel approval" }),
  });
  const cancelledResponse = await cancelledPending;
  assert.ok([403, 409].includes(cancelledResponse.status));
  await cancelledResponse.arrayBuffer();
  await waitFor(
    async () =>
      (await api<CuaApprovalRecord[]>(`/api/v1/approvals?taskId=${cancelledTaskId}`))[0]?.status ===
      "cancelled",
    "approval cancelled with task",
  );
  await waitIdle();
  passed("任务取消会立即取消等待中的审批，动作不执行");

  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: [] }),
  });

  const timeoutTaskId = await newRunningTask();
  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: ["type_text"], approvalTimeoutMs: 1000 }),
  });
  const timeoutObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const timedOut = await broker(
    "/v1/actions",
    {
      action: { type: "type_text", text: "timeout", screenshotId: timeoutObservation.screenshotId },
    },
    10_000,
  );
  assert.equal(timedOut.status, 409);
  await timedOut.arrayBuffer();
  const timeoutApprovals = await api<CuaApprovalRecord[]>(
    `/api/v1/approvals?taskId=${timeoutTaskId}`,
  );
  assert.equal(timeoutApprovals[0]?.status, "timed_out");
  await api(`/api/v1/tasks/${timeoutTaskId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "smoke timeout cleanup" }),
  });
  await waitIdle();
  passed("审批超时会拒绝动作并保留可审计的超时记录");

  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({
      approvalActionTypes: [],
      duplicateActionLimit: 2,
      noProgressLimit: 50,
      maxSteps: 80,
    }),
  });
  advanceScreen = false;
  screenshotCounter = 0;
  const duplicateTaskId = await newRunningTask();
  let duplicateScreenshot = (await brokerJson<{ screenshotId: string }>("/v1/observe", {}))
    .screenshotId;
  let duplicateFailure: Response | undefined;
  for (let index = 0; index < 3; index += 1) {
    const response = await broker("/v1/actions", {
      action: { type: "click", point: { x: 50, y: 50 } },
      screenshotId: duplicateScreenshot,
    });
    if (response.status !== 200) {
      duplicateFailure = response;
      break;
    }
    const payload = (await response.json()) as { screenshotId: string };
    duplicateScreenshot = payload.screenshotId;
  }
  assert.ok(duplicateFailure);
  assert.equal(duplicateFailure!.status, 409);
  await duplicateFailure!.arrayBuffer();
  assert.equal((await task(duplicateTaskId)).task.errorCode, "cua_duplicate_action");
  await waitIdle();
  advanceScreen = true;
  passed("重复动作且屏幕无变化会被检测并阻塞任务，不无限点击");

  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: [], maxSteps: 2 }),
  });
  const stepTaskId = await newRunningTask();
  const stepObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const stepClick = await brokerJson<{ screenshotId: string }>("/v1/actions", {
    action: { type: "click", point: { x: 9, y: 9 } },
    screenshotId: stepObservation.screenshotId,
  });
  const stepFailure = await broker("/v1/actions", {
    action: { type: "click", point: { x: 10, y: 10 } },
    screenshotId: stepClick.screenshotId,
  });
  assert.equal(stepFailure.status, 409);
  await stepFailure.arrayBuffer();
  assert.equal((await task(stepTaskId)).task.errorCode, "cua_step_limit");
  await waitIdle();
  passed("最大步数触发后任务阻塞，不会继续执行");

  await api(`/api/v1/projects/${projectId}/policy`, {
    method: "PUT",
    body: JSON.stringify({ approvalActionTypes: [], maxSteps: 40, noProgressLimit: 20 }),
  });
  const completeTaskId = await newRunningTask();
  verifyOk = true;
  const completed = await brokerJson<{ completed: boolean; evidence: unknown[] }>("/v1/complete", {
    summary: "报告已保存到 Guest 工作区",
    evidence: [
      {
        type: "file",
        path: "/home/worker/workspace/report.txt",
        sha256: "b".repeat(64),
        sizeBytes: 12,
      },
      { type: "process", name: "mousepad" },
    ],
  });
  assert.equal(completed.completed, true);
  assert.equal(verifyCalls.length, 1);
  assert.equal((await task(completeTaskId)).task.status, "completed");
  const traceAfterComplete = await api<TaskTraceView>(`/api/v1/tasks/${completeTaskId}/trace`);
  assert.equal(traceAfterComplete.execution?.outcome, "completed");
  assert.ok(
    (await task(completeTaskId)).events.some(
      (event) => event.type === "worker.completion_verified",
    ),
  );
  await api(`/api/v1/workers/${workerId}/abort`, { method: "POST", body: "{}" });
  await waitIdle();
  passed("任务完成必须通过 Guest 文件/进程独立证据校验");

  const screenshotTaskId = await newRunningTask();
  const screenshotObservation = await brokerJson<{ screenshotId: string }>("/v1/observe", {});
  const screenshotComplete = await brokerJson<{ completed: boolean }>("/v1/complete", {
    summary: "屏幕状态即完成证据",
    evidence: [{ type: "screenshot", screenshotId: screenshotObservation.screenshotId }],
  });
  assert.equal(screenshotComplete.completed, true);
  const screenshotTrace = await api<TaskTraceView>(`/api/v1/tasks/${screenshotTaskId}/trace`);
  assert.ok(screenshotTrace.screenshots.some((shot) => shot.kind === "completion"));
  await api(`/api/v1/workers/${workerId}/abort`, { method: "POST", body: "{}" });
  await waitIdle();
  passed("完成校验会重新捕获屏幕并记录 completion 截图");

  const traceAudit = await api<TaskTraceView>(`/api/v1/tasks/${traceTaskId}/trace`);
  assert.equal(traceAudit.actions[0]?.workerId, workerId);
  assert.equal(traceAudit.execution?.stepCount, 2);
  assert.ok((await worker()).worker.status === "idle");
  passed("任务 Trace 保留动作、截图、审批和执行统计");
} catch (error) {
  checks.push({
    name: "phase7 smoke",
    passed: false,
    detail: error instanceof Error ? stackSummary(error) : String(error),
  });
  console.error("FAIL:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await stopChild(controlPlane);
  await workerServer?.close().catch(() => undefined);
  if (guestServer) {
    guestServer.closeAllConnections();
    await new Promise<void>((resolve) => guestServer!.close(() => resolve()));
  }
  if (supervisorServer) {
    supervisorServer.closeAllConnections();
    await new Promise<void>((resolve) => supervisorServer!.close(() => resolve()));
  }
  await rm(temporary, { recursive: true, force: true });
  const finishedAt = new Date().toISOString();
  const result = {
    name: "agent-in-box-phase7-smoke",
    startedAt,
    finishedAt,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
    boundaries: {
      realChildProcess: true,
      realControlPlane: true,
      realSqlite: true,
      realCuaBrokerHttp: true,
      realGuestAgent: false,
      realQemuWxpx: false,
      realPiProcess: false,
      realModel: false,
      browserElectronUi: false,
    },
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ resultPath, status: result.status, checks: checks.length }));
  process.exit(process.exitCode ?? 0);
}

async function handleGuest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.authorization !== `Bearer ${guestToken}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad token" } }),
    );
    return;
  }
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/desktop") {
    writeJson(response, 200, { displayServer: "x11", ...fakeDisplay });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/screenshot") {
    screenshotCounter += 1;
    const bytes = advanceScreen
      ? Buffer.concat([PNG, Buffer.from(String(screenshotCounter))])
      : PNG;
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-agent-in-box-action-id": `shot-${screenshotCounter}`,
      "x-agent-in-box-width": String(fakeDisplay.width),
      "x-agent-in-box-height": String(fakeDisplay.height),
    });
    response.end(bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/input") {
    const body = await readJson(request);
    inputCalls.push(body);
    writeJson(response, 200, {
      actionId: body.actionId ?? "guest-action",
      ok: true,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/verify") {
    const body = await readJson(request);
    verifyCalls.push(body);
    const checks = Array.isArray(body.checks) ? body.checks : [];
    writeJson(response, 200, {
      actionId: body.actionId ?? "guest-verify",
      ok: verifyOk,
      checks: checks.map((check: Record<string, unknown>) => ({
        type: check.type,
        ok: verifyOk,
        ...(verifyOk ? {} : { errorCode: "smoke_verify_failed", error: "smoke verify failed" }),
        ...(check.type === "file"
          ? {
              path: check.path,
              sizeBytes: check.sizeBytes ?? 12,
              sha256: check.sha256 ?? "c".repeat(64),
            }
          : {}),
        ...(check.type === "process" ? { pids: [777] } : {}),
      })),
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "guest route" } }));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stackSummary(error: Error): string {
  return (error.stack ?? error.message).split("\n").slice(0, 8).join("\n");
}
