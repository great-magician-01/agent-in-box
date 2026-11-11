import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ActiveRosterView,
  RouterMessageRecord,
  RouterToolCallRecord,
  RouterView,
  TaskDetail,
  TaskRecord,
  WorkerArchiveRecord,
  WorkerResumeResult,
  WorkerSummaryView,
  WorkerView,
} from "@agent-in-box/protocol";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase8-"));
const resultPath =
  process.env.AGENT_IN_BOX_PHASE8_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase8/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const controlPlanePort = await freePort();
const supervisorPort = await freePort();
const modelBrokerPort = await freePort();
const cuaBrokerPort = await freePort();
const routerBrokerPort = await freePort();
const workerRpcToken = "phase8-worker-rpc-token";
const guestToken = "phase8-guest-token";
const routerArgsLog = path.join(temporary, "router-pi-args.json");
const routerEnvLog = path.join(temporary, "router-pi-env.json");
const startedAt = new Date().toISOString();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BGDs0ABwABf/9WlFTKAAAAAElFTkSuQmCC",
  "base64",
);
let controlPlane: ChildProcess | undefined;
let workerServer: { close(): Promise<void> } | undefined;
let supervisorServer: Server | undefined;
let guestServer: Server | undefined;
let screenshotCalls = 0;
let vmId = "";
let projectId = "";
let workerId = "";
let firstTaskId = "";
let secondTaskId = "";
const watchdog = setTimeout(() => {
  console.error(`phase8 smoke watchdog timeout after ${checks.length} checks`);
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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeout = 30_000,
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
    signal: AbortSignal.timeout(30_000),
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
        AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: path.join(temporary, "supervisor-acl.token"),
        AGENT_IN_BOX_MODEL_BROKER_PORT: String(modelBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_PORT: String(cuaBrokerPort),
        AGENT_IN_BOX_CUA_BROKER_GUEST_URL: `http://127.0.0.1:${cuaBrokerPort}`,
        AGENT_IN_BOX_ROUTER_BROKER_PORT: String(routerBrokerPort),
        AGENT_IN_BOX_ROUTER_PI_BINARY: process.execPath,
        AGENT_IN_BOX_ROUTER_PI_ARGS: JSON.stringify([
          path.join(repository, "tests/phase8/fake-router-pi.mjs"),
        ]),
        AGENT_IN_BOX_ROUTER_PROVIDER: "mock",
        AGENT_IN_BOX_ROUTER_MODEL: "router-model",
        PHASE8_PROJECT_ID: projectId,
        PHASE8_OBJECTIVE: "[hold] Phase 8 smoke desktop task",
        PHASE8_SECOND_OBJECTIVE: "Phase 8 archive follow-up",
        PHASE8_ROUTER_ARGS_LOG: routerArgsLog,
        PHASE8_ROUTER_ENV_LOG: routerEnvLog,
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
      const cua = await fetch(`http://127.0.0.1:${cuaBrokerPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      const router = await fetch(`http://127.0.0.1:${routerBrokerPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (health.ok && cua.ok && router.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Control plane, Computer Use Broker or Router Broker did not become healthy");
}

function routerView(): Promise<RouterView> {
  return api<RouterView>("/api/v1/router");
}

function routerMessages(): Promise<RouterMessageRecord[]> {
  return api<RouterMessageRecord[]>("/api/v1/router/messages?limit=100");
}

function worker(): Promise<WorkerView> {
  return api<WorkerView>(`/api/v1/workers/${workerId}`);
}

function task(taskId: string): Promise<TaskDetail> {
  return api<TaskDetail>(`/api/v1/tasks/${taskId}`);
}

async function waitRouterIdle(): Promise<void> {
  await waitFor(async () => (await routerView()).status === "idle", "router idle");
}

async function waitWorkerIdle(): Promise<void> {
  await waitFor(async () => (await worker()).worker.status === "idle", "worker idle");
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
  await writeFile(path.join(temporary, "supervisor-acl.token"), "phase8-supervisor-token", {
    mode: 0o600,
  });

  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 8 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const project = await catalog.createProject({
    name: "Phase 8 Router project",
    description: "Phase 8 smoke project",
  });
  const vm = await catalog.createVm({
    name: "Phase 8 Router VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "phase8-vm"),
  });
  const conversation = await catalog.createConversation({
    kind: "project",
    projectId: project.id,
    title: "Phase 8 Worker conversation",
  });
  const workspacePath = path.join(temporary, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await catalog.bindVm({
    projectId: project.id,
    vmId: vm.id,
    // The fake Guest Worker Pi runs on this host in the smoke, so its cwd must
    // be a real host directory. The production path is a guest path.
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
    if (request.headers.authorization !== "Bearer phase8-supervisor-token") {
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
  const migrated = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  const tables = migrated.sqlite
    .prepare("select name from sqlite_master where type = 'table'")
    .all() as Array<{ name: string }>;
  const names = tables.map((row) => row.name);
  for (const table of [
    "worker_archives",
    "worker_resume_contexts",
    "worker_inputs",
    "router_sessions",
    "router_messages",
    "router_tool_calls",
    "router_model_tokens",
  ]) {
    assert.ok(names.includes(table), `missing ${table}`);
  }
  await migrated.close();
  passed("真实控制平面应用阶段 8 迁移并启动 Router Tool Broker");

  await api("/api/v1/models/providers/mock", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      credentialProviderId: "mock",
      models: [
        { id: "mock-cua", name: "Mock Computer Use" },
        { id: "router-model", name: "Mock Router" },
      ],
      enabled: true,
    }),
  });
  const created = await api<WorkerView>("/api/v1/workers", {
    method: "POST",
    body: JSON.stringify({ projectId, vmId, conversationId: conversation.id }),
  });
  workerId = created.worker.id;
  assert.equal(created.worker.status, "idle");
  passed("创建项目 Worker 并保持 Guest RPC 连接", `worker=${workerId}`);

  const router = await routerView();
  assert.equal(router.status, "idle");
  const toolNames = router.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("list_active_workers"));
  assert.ok(toolNames.includes("create_task"));
  assert.ok(toolNames.includes("search_worker_archive"));
  assert.ok(toolNames.every((name) => !/shell|vm_input|supervisor|click|keypress/.test(name)));
  assert.ok(router.tools.every((tool) => Object.keys(tool.parameters).length > 0));
  passed("Router 只暴露项目、任务、Worker、看板与归档工具");

  await api("/api/v1/router/messages", {
    method: "POST",
    body: JSON.stringify({ text: "CREATE-FIRST: reuse the existing worker" }),
  });
  await waitRouterIdle();
  const firstTasks = await api<{ items: TaskRecord[] }>(`/api/v1/tasks?projectId=${projectId}`);
  assert.ok(firstTasks.items.length >= 1, "Router did not create a task");
  firstTaskId = firstTasks.items[0]!.id;
  await waitFor(async () => {
    const detail = await task(firstTaskId);
    return detail.task.status === "running" && Boolean(detail.task.assignedWorkerId);
  }, "first task claimed by Worker");
  const firstDetail = await task(firstTaskId);
  assert.equal(firstDetail.task.vmId, vmId);
  assert.ok(firstDetail.task.assignedWorkerId, "task was not assigned to a Worker");
  const routerMessagesAfterFirst = await routerMessages();
  assert.ok(routerMessagesAfterFirst.some((message) => message.role === "assistant"));
  const toolCalls = await api<RouterToolCallRecord[]>("/api/v1/router/tool-calls?limit=50");
  const called = toolCalls.map((call) => call.toolName);
  assert.ok(called.includes("list_active_workers"));
  assert.ok(called.includes("find_related_worker"));
  assert.ok(called.includes("assign_task"));
  const routerEnv = JSON.parse(await readFile(routerEnvLog, "utf8")) as {
    routerUrl: string;
    hasToken: boolean;
  };
  assert.equal(routerEnv.routerUrl, `http://127.0.0.1:${routerBrokerPort}`);
  assert.equal(routerEnv.hasToken, true);
  passed("Router 查询已有 Worker 后向该 Worker 分派任务", `task=${firstTaskId}`);

  await api(`/api/v1/tasks/${firstTaskId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "phase 8 smoke cleanup" }),
  });
  await waitFor(
    async () => (await task(firstTaskId)).task.status === "cancelled",
    "first task cancelled",
  );
  await waitWorkerIdle();
  passed("取消任务后 Worker 停止回合并回到 idle");

  const archived = await api<WorkerView>(`/api/v1/workers/${workerId}/archive`, {
    method: "POST",
  });
  assert.equal(archived.worker.status, "archived");
  const archives = await api<{ items: WorkerArchiveRecord[] }>(
    `/api/v1/registry/archives?projectId=${projectId}&query=${encodeURIComponent("Phase 8")}`,
  );
  assert.equal(archives.items.length, 1);
  assert.ok(archives.items[0]!.summary.includes("Phase 8"));
  const roster = await api<ActiveRosterView>(`/api/v1/registry/workers?projectId=${projectId}`);
  assert.equal(roster.workers.length, 0);
  const summary = await api<WorkerSummaryView>(`/api/v1/registry/workers/${workerId}/summary`);
  assert.equal(summary.worker.status, "archived");
  assert.ok(summary.latestArchive?.archiveRef);
  passed("归档写入 Archive Registry，Active Roster 可重建且不再包含归档 Worker");

  const resumed = await api<WorkerResumeResult>(`/api/v1/workers/${workerId}/resume`, {
    method: "POST",
    body: JSON.stringify({ mode: "native" }),
  });
  assert.equal(resumed.restoreMode, "native");
  assert.ok(resumed.context.screenshot?.sha256, "resume context has no screenshot");
  await waitWorkerIdle();
  assert.ok(screenshotCalls >= 1);
  const contexts = await api<WorkerArchiveRecord[]>(`/api/v1/workers/${workerId}/archives`);
  assert.equal(contexts[0]!.status, "restored");
  passed("同版本原生恢复并注入最新截图与环境摘要，归档标记 restored");

  await api("/api/v1/router/messages", {
    method: "POST",
    body: JSON.stringify({ text: "AFTER-ARCHIVE: continue with the archived context" }),
  });
  await waitRouterIdle();
  const allTasks = await api<{ items: TaskRecord[] }>(`/api/v1/tasks?projectId=${projectId}`);
  secondTaskId = allTasks.items.find((item) => item.id !== firstTaskId)?.id ?? "";
  assert.ok(secondTaskId, "Router did not create the follow-up task");
  await waitFor(
    async () =>
      ["running", "blocked", "completed"].includes((await task(secondTaskId)).task.status),
    "second task started",
  );
  passed("归档后 Router 检索归档并创建后续任务", `task=${secondTaskId}`);

  const beforeRestartMessages = (await routerMessages()).length;
  await stopChild(controlPlane);
  controlPlane = undefined;
  await startControlPlane();
  const resumedRouter = await routerView();
  assert.ok(resumedRouter.conversationId);
  await api("/api/v1/router/messages", {
    method: "POST",
    body: JSON.stringify({ text: "AFTER-RESTART: summarize persisted assignments" }),
  });
  await waitRouterIdle();
  const afterRestartMessages = await routerMessages();
  assert.ok(afterRestartMessages.length > beforeRestartMessages);
  const afterRestartCalls = await api<RouterToolCallRecord[]>(
    "/api/v1/router/tool-calls?limit=100",
  );
  assert.ok(afterRestartCalls.some((call) => call.toolName === "get_board_summary"));
  const routerArgs = JSON.parse(await readFile(routerArgsLog, "utf8")) as {
    resumed: boolean;
    args: string[];
  };
  assert.equal(routerArgs.resumed, true);
  const historical = await api<{ items: TaskRecord[] }>(`/api/v1/tasks?workerId=${workerId}`);
  assert.ok(historical.items.some((item) => item.id === firstTaskId));
  passed(
    "Router 重启后恢复会话并继续读取持久化任务分配",
    `messages=${afterRestartMessages.length}`,
  );

  const audit = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  const topics = (
    audit.sqlite.prepare("select distinct topic from outbox").all() as Array<{ topic: string }>
  ).map((row) => row.topic);
  for (const topic of [
    "router.message",
    "router.status_changed",
    "worker.archived",
    "worker.resumed",
  ]) {
    assert.ok(topics.includes(topic), `missing outbox topic ${topic}`);
  }
  const archiveRows = audit.sqlite
    .prepare("select count(*) as count from worker_archives")
    .get() as { count: number };
  assert.equal(Number(archiveRows.count), 1);
  const resumeRows = audit.sqlite
    .prepare("select count(*) as count from worker_resume_contexts")
    .get() as { count: number };
  assert.ok(Number(resumeRows.count) >= 1);
  const archiveDir = path.join(temporary, "archives", "resume-contexts");
  const files = await stat(archiveDir);
  assert.ok(files.isDirectory());
  await audit.close();
  passed("Outbox、归档表、恢复上下文与截图文件均已持久化");

  await stopChild(controlPlane);
  controlPlane = undefined;
  if (workerServer) await workerServer.close();
  workerServer = undefined;
  if (supervisorServer) {
    supervisorServer.closeAllConnections();
    await new Promise<void>((resolve) => supervisorServer!.close(() => resolve()));
  }
  if (guestServer) {
    guestServer.closeAllConnections();
    await new Promise<void>((resolve) => guestServer!.close(() => resolve()));
  }
  await rm(temporary, { recursive: true, force: true });
  clearTimeout(watchdog);
  const finishedAt = new Date().toISOString();
  const result = {
    name: "agent-in-box-phase8-smoke",
    startedAt,
    finishedAt,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
    boundaries: {
      realChildProcess: true,
      realControlPlane: true,
      realSqlite: true,
      realRouterToolBrokerHttp: true,
      realWorkerRpc: true,
      realGuestAgent: false,
      realQemuWxpx: false,
      realPiProcess: false,
      realRouterPi: false,
      realModel: false,
      browserElectronUi: false,
    },
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ resultPath, status: result.status, checks: checks.length }));
  process.exit(process.exitCode ?? 0);
} catch (error) {
  clearTimeout(watchdog);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  for (const child of children) child.kill("SIGKILL");
  await workerServer?.close().catch(() => undefined);
  if (supervisorServer) {
    supervisorServer.closeAllConnections();
    await new Promise<void>((resolve) => supervisorServer!.close(() => resolve()));
  }
  if (guestServer) {
    guestServer.closeAllConnections();
    await new Promise<void>((resolve) => guestServer!.close(() => resolve()));
  }
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
}

async function handleGuest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.authorization !== `Bearer ${guestToken}`) {
    writeJson(response, 401, { ok: false, error: { code: "unauthorized", message: "bad token" } });
    return;
  }
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/desktop") {
    writeJson(response, 200, {
      displayServer: "x11",
      width: 1280,
      height: 720,
      dpi: 96,
      scaleFactor: 1,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/screenshot") {
    screenshotCalls += 1;
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-agent-in-box-action-id": `phase8-shot-${screenshotCalls}`,
      "x-agent-in-box-width": "1280",
      "x-agent-in-box-height": "720",
    });
    response.end(PNG);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/input") {
    const body = await readJson(request);
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
    const checks = Array.isArray(body.checks) ? body.checks : [];
    writeJson(response, 200, {
      actionId: body.actionId ?? "guest-verify",
      ok: true,
      checks: checks.map((check: Record<string, unknown>) => ({
        type: check.type,
        ok: true,
        ...(check.type === "file"
          ? { path: check.path, sizeBytes: 12, sha256: "c".repeat(64) }
          : {}),
        ...(check.type === "process" ? { pids: [777] } : {}),
      })),
    });
    return;
  }
  writeJson(response, 404, { ok: false, error: { code: "not_found", message: "guest route" } });
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
