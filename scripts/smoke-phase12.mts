import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DiagnosticsReport,
  ProjectDetail,
  RouterMessageRecord,
  RouterToolDefinition,
  TaskBoardSnapshot,
  TaskDetail,
} from "@agent-in-box/protocol";
import { smokeAccessKey, smokeAuthHeaders } from "./smoke-auth.mjs";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase12-"));
const configDirectory = path.join(temporary, "config");
const databaseFile = path.join(temporary, "agent-in-box.sqlite");
const backupsDirectory = path.join(temporary, "backups");
const resultPath =
  process.env.AGENT_IN_BOX_PHASE12_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase12/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );

const controlPlanePort = await freePort();
const modelBrokerPort = await freePort();
const cuaBrokerPort = await freePort();
const routerBrokerPort = await freePort();
const baseUrl = `http://127.0.0.1:${controlPlanePort}`;
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const startedAt = new Date().toISOString();
const performanceTaskCount = 2000;
const routerMessageCount = 500;
const metrics: Record<string, number | string | boolean> = {};

let controlPlane: ChildProcess | undefined;
let projectId = "";
let vmId = "";
let conversationId = "";
let workerId = "";
let runningTaskId = "";

const watchdog = setTimeout(() => {
  console.error(`phase12 smoke watchdog timeout after ${checks.length} checks`);
  for (const child of children) child.kill("SIGKILL");
  process.exit(2);
}, 300_000);

function passed(name: string, detail?: string): void {
  checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
  console.log(`PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

function controlPlaneEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTROL_PLANE_HOST: "127.0.0.1",
    CONTROL_PLANE_PORT: String(controlPlanePort),
    AGENT_IN_BOX_DATA_ROOT: temporary,
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    AGENT_IN_BOX_WEB_ROOT: path.join(repository, "apps", "web", "dist"),
    AGENT_IN_BOX_NOTIFICATION_TICK_MS: "100",
    AGENT_IN_BOX_RESOURCE_TICK_MS: "600000",
    AGENT_IN_BOX_MODEL_BROKER_HOST: "127.0.0.1",
    AGENT_IN_BOX_MODEL_BROKER_PORT: String(modelBrokerPort),
    AGENT_IN_BOX_CUA_BROKER_HOST: "127.0.0.1",
    AGENT_IN_BOX_CUA_BROKER_PORT: String(cuaBrokerPort),
    AGENT_IN_BOX_ROUTER_BROKER_HOST: "127.0.0.1",
    AGENT_IN_BOX_ROUTER_BROKER_PORT: String(routerBrokerPort),
    AGENT_IN_BOX_MIGRATION_BACKUP_KEEP: "3",
    AGENT_IN_BOX_DIAGNOSTICS_LOG_BYTES: "131072",
    NODE_ENV: "test",
  };
}

async function startControlPlane(): Promise<void> {
  controlPlane = spawn(
    process.execPath,
    [path.join(repository, "services/control-plane/dist/main.js")],
    {
      cwd: repository,
      env: controlPlaneEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  children.push(controlPlane);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (controlPlane.exitCode !== null) {
      throw new Error(`control-plane exited early with ${controlPlane.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Retry while Nest and brokers bind.
    }
    await delay(100);
  }
  throw new Error("control plane did not become healthy");
}

async function crashControlPlane(): Promise<void> {
  if (!controlPlane || controlPlane.exitCode !== null || controlPlane.signalCode !== null) {
    controlPlane = undefined;
    return;
  }
  const exited = once(controlPlane, "exit");
  controlPlane.kill("SIGKILL");
  await Promise.race([exited, delay(10_000)]);
  controlPlane = undefined;
}

function accessKey(): string {
  return smokeAccessKey(configDirectory);
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...smokeAuthHeaders(configDirectory), ...extra };
}

async function request(
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await request(route, {
    ...init,
    headers: {
      accept: "application/json",
      ...bearerHeaders(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status >= 400) {
    throw new Error(`${route} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as T;
}

function rawRequest(route: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port: controlPlanePort, path: route, method: "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

interface SessionCookie {
  cookie: string;
  csrfToken: string;
}

async function login(): Promise<SessionCookie> {
  const response = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: accessKey(), label: "phase12-smoke" }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  const cookie = setCookie.split(";")[0]!;
  const body = response.body as { csrfToken?: string };
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken };
}

function distUrl(name: string): string {
  return pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
}

async function loadControlPlaneClasses(): Promise<{
  AppDatabase: {
    open(options: { filename: string }): {
      db: unknown;
      sqlite: unknown;
      migrate(): Promise<string[]>;
      close(): Promise<void>;
    };
  };
  CatalogRepository: new (db: unknown) => {
    createImage(input: Record<string, unknown>): Promise<{ id: string }>;
    createVm(input: Record<string, unknown>): Promise<{ id: string }>;
    createConversation(input: Record<string, unknown>): Promise<{ id: string }>;
    bindVm(input: Record<string, unknown>): Promise<unknown>;
  };
  TaskRepository: new (db: unknown) => unknown;
  OutboxRepository: new (db: unknown) => unknown;
  WorkerRepository: new (db: unknown) => {
    createWorker(input: Record<string, unknown>): Promise<{ id: string }>;
    updateRuntime(id: string, patch: Record<string, unknown>): Promise<unknown>;
  };
  LeaseRepository: new (db: unknown) => unknown;
  TaskService: new (
    db: unknown,
    tasks: unknown,
    outbox: unknown,
  ) => { create(input: Record<string, unknown>): Promise<{ task: { id: string } }> };
  LeaseService: new (
    db: unknown,
    leases: unknown,
  ) => { acquire(input: Record<string, unknown>): Promise<unknown> };
  sha256File: (file: string) => Promise<string>;
  inspectMigrationBackup: (file: string) => Promise<void>;
}> {
  const [{ AppDatabase }, { CatalogRepository }, taskRepository, outboxRepository, workerRepository, leaseRepository, taskService, leaseService, backup] =
    await Promise.all([
      import(distUrl("persistence/database.js")),
      import(distUrl("persistence/repositories/catalog-repository.js")),
      import(distUrl("persistence/repositories/task-repository.js")),
      import(distUrl("persistence/repositories/outbox-repository.js")),
      import(distUrl("persistence/repositories/worker-repository.js")),
      import(distUrl("persistence/repositories/lease-repository.js")),
      import(distUrl("persistence/services/task-service.js")),
      import(distUrl("persistence/services/lease-service.js")),
      import(distUrl("persistence/migration-backup.js")),
    ]);
  return {
    AppDatabase,
    CatalogRepository,
    TaskRepository: taskRepository.TaskRepository,
    OutboxRepository: outboxRepository.OutboxRepository,
    WorkerRepository: workerRepository.WorkerRepository,
    LeaseRepository: leaseRepository.LeaseRepository,
    TaskService: taskService.TaskService,
    LeaseService: leaseService.LeaseService,
    sha256File: backup.sha256File,
    inspectMigrationBackup: backup.inspectMigrationBackup,
  };
}

async function seedFailureAndPerformanceFixtures(): Promise<number> {
  const classes = await loadControlPlaneClasses();
  const database = classes.AppDatabase.open({ filename: databaseFile });
  await database.migrate();
  const db = database.db as {
    transaction(): {
      execute<T>(callback: (trx: unknown) => Promise<T>): Promise<T>;
    };
    insertInto(table: string): {
      values(values: unknown): { execute(): Promise<void> };
    };
    updateTable(table: string): {
      set(values: unknown): {
        where(column: string, operator: string, value: string): { execute(): Promise<void> };
      };
    };
    deleteFrom(table: string): {
      where(column: string, operator: string, value: string): { execute(): Promise<void> };
    };
    selectFrom(table: string): {
      selectAll(): {
        where(column: string, operator: string, value: string): {
          executeTakeFirst(): Promise<unknown>;
        };
      };
    };
  };
  const catalog = new classes.CatalogRepository(db);
  const image = await catalog.createImage({
    name: "Phase 12 Linux image",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "phase12-test",
    sizeBytes: 1024,
    checksum: "phase12-checksum",
  });
  const vm = await catalog.createVm({
    name: "Phase 12 VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    diskBytes: 20 * 1024 * 1024 * 1024,
    storageRoot: temporary,
  });
  vmId = vm.id;
  const conversation = await catalog.createConversation({
    kind: "project",
    projectId,
    title: "Phase 12 project",
  });
  conversationId = conversation.id;
  await catalog.bindVm({
    projectId,
    vmId,
    guestWorkspacePath: "/home/worker/workspace",
    isPrimary: true,
  });

  const workers = new classes.WorkerRepository(db);
  const worker = await workers.createWorker({
    projectId,
    vmId,
    conversationId,
    engineType: "pi-rpc",
    engineVersion: "1.5.1",
    capabilitySet: ["screenshot", "click"],
  });
  workerId = worker.id;

  const tasks = new classes.TaskService(
    db,
    new classes.TaskRepository(db),
    new classes.OutboxRepository(db),
  );
  const created = await tasks.create({
    projectId,
    vmId,
    originConversationId: conversationId,
    objective: "Phase 12 crash recovery task",
    idempotencyKey: "phase12-crash-recovery",
  });
  runningTaskId = created.task.id;

  const now = new Date().toISOString();
  await db
    .insertInto("vm_leases")
    .values({
      id: "phase12-lease",
      vm_id: vmId,
      owner: "worker",
      task_id: runningTaskId,
      acquired_at: now,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    })
    .execute();
  // TaskService already inserted the task as queued; turn it into the exact
  // state a Worker would persist just before a control-plane crash.
  await db
    .updateTable("tasks")
    .set({
      assigned_worker_id: workerId,
      status: "running",
      started_at: now,
      attempt_count: 1,
      updated_at: now,
    })
    .where("id", "=", runningTaskId)
    .execute();
  await workers.updateRuntime(workerId, {
    status: "running",
    currentTaskId: runningTaskId,
    agentSessionRef: "phase12-session",
    sessionVersion: "1",
    lastHeartbeatAt: now,
    providerId: "phase12-provider",
    modelId: "phase12-model",
  });
  const leases = new classes.LeaseService(db, new classes.LeaseRepository(db));
  await leases.acquire({ vmId, owner: "worker", taskId: runningTaskId, ttlMs: 120_000 });

  const routerConversation = await catalog.createConversation({
    kind: "router",
    projectId: null,
    title: "Router main",
  });
  const rows: unknown[] = [];
  for (let index = 0; index < routerMessageCount; index += 1) {
    rows.push({
      id: `phase12-router-message-${String(index).padStart(4, "0")}`,
      conversation_id: routerConversation.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `phase12 router history ${index}`,
      created_at: new Date(Date.now() - (routerMessageCount - index) * 1000).toISOString(),
    });
  }
  for (let offset = 0; offset < rows.length; offset += 100) {
    await db
      .insertInto("router_messages")
      .values(rows.slice(offset, offset + 100))
      .execute();
  }

  const tasksRows: unknown[] = [];
  for (let index = 0; index < performanceTaskCount; index += 1) {
    tasksRows.push({
      id: `phase12-perf-task-${String(index).padStart(4, "0")}`,
      project_id: projectId,
      vm_id: vmId,
      origin_conversation_id: conversationId,
      assigned_worker_id: null,
      parent_task_id: null,
      objective: `Phase 12 performance history ${index}`,
      status: "completed",
      priority: 0,
      latest_summary: "done",
      error_code: null,
      created_at: new Date(Date.now() - (performanceTaskCount - index) * 1000).toISOString(),
      started_at: null,
      completed_at: new Date(Date.now() - (performanceTaskCount - index) * 1000).toISOString(),
      attempt_count: 1,
      result_json: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    });
  }
  for (let offset = 0; offset < tasksRows.length; offset += 100) {
    await db
      .insertInto("tasks")
      .values(tasksRows.slice(offset, offset + 100))
      .execute();
  }

  // Force one pending migration so startup has to create a pre-migration backup.
  await db
    .deleteFrom("schema_migrations")
    .where("id", "=", "011_phase12_hardening")
    .execute();
  await database.close();
  return performanceTaskCount + 1;
}

async function latestBackupFile(): Promise<string> {
  const entries = await readdir(backupsDirectory);
  const backups = entries.filter(
    (name) => name.startsWith("pre-migration-") && name.endsWith(".sqlite"),
  );
  assert.ok(backups.length > 0, "pre-migration backup was not created");
  backups.sort();
  return path.join(backupsDirectory, backups.at(-1)!);
}

try {
  await startControlPlane();
  passed("控制平面启动并保持回环监听");

  const health = await request("/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal((health.body as { status: string }).status, "ok");
  const maliciousHost = await rawRequest("/api/v1/health", { host: "evil.example" });
  assert.equal(maliciousHost.status, 403);
  const unauthenticated = await request("/api/v1/projects");
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await request("/api/v1/projects", {
    headers: bearerHeaders({ origin: `http://127.0.0.1:${await freePort()}` }),
  });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await request("/api/v1/projects", {
    headers: bearerHeaders({ "sec-fetch-site": "cross-site" }),
  });
  assert.equal(crossSite.status, 403);
  passed("Host/Origin/Sec-Fetch-Site 边界与未认证 API 拒绝生效");

  const staticPage = await request("/");
  assert.equal(staticPage.status, 200);
  assert.match(staticPage.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(staticPage.headers.get("x-frame-options"), "DENY");
  const cors = await request("/api/v1/health", {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:1" },
  });
  assert.equal(cors.headers.get("access-control-allow-origin"), null);
  passed("静态 Web 安全头生效且没有宽松 CORS", `OPTIONS ${cors.status}`);

  const session = await login();
  const csrfMissing = await request("/api/v1/projects", {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "CSRF rejection" }),
  });
  assert.equal(csrfMissing.status, 403);
  const project = await request("/api/v1/projects", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      "x-agent-in-box-csrf": session.csrfToken,
    },
    body: JSON.stringify({ name: "Phase 12 acceptance project" }),
  });
  assert.ok(project.status === 200 || project.status === 201, JSON.stringify(project.body));
  projectId = (project.body as ProjectDetail).project.id;
  passed("Cookie 会话写操作强制 CSRF，Bearer/Cookie 认证可用");

  const logsDirectory = path.join(configDirectory, "logs");
  await mkdir(logsDirectory, { recursive: true });
  await writeFile(
    path.join(logsDirectory, "desktop.log"),
    [
      "control-plane failure with Bearer abcdefghijklmnop",
      `access key aib_${"Q".repeat(28)}`,
      "provider sk-live-abcdefghijklmnopqrstuvwxyz",
      '{"appSecret":"feishu-secret-value","message":"visible diagnostics text"}',
    ].join("\n"),
  );
  const noAuthDiagnostics = await request("/api/v1/diagnostics");
  assert.equal(noAuthDiagnostics.status, 401);
  const diagnostics = await api<DiagnosticsReport>("/api/v1/diagnostics");
  assert.match(diagnostics.warning, /敏感/);
  assert.ok(diagnostics.database.appliedMigrations.includes("011_phase12_hardening"));
  assert.equal(diagnostics.database.pendingMigrations.length, 0);
  assert.equal(diagnostics.database.quickCheck, "ok");
  assert.ok(diagnostics.checks.some((check) => check.name === "SQLite 完整性"));
  assert.match(diagnostics.logs.content, /visible diagnostics text/);
  assert.match(diagnostics.logs.content, /\[REDACTED/);
  const serializedDiagnostics = JSON.stringify(diagnostics);
  const key = accessKey();
  assert.equal(serializedDiagnostics.includes(key), false);
  assert.equal(serializedDiagnostics.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(serializedDiagnostics.includes("feishu-secret-value"), false);
  const runtime = await api<Record<string, unknown>>("/api/v1/runtime");
  assert.equal(JSON.stringify(runtime).includes(key), false);
  passed("诊断报告要求认证，包含迁移/计数/日志并在导出前脱敏凭据");

  const routerTools = await api<RouterToolDefinition[]>("/api/v1/router/tools");
  assert.ok(routerTools.length > 0);
  for (const tool of routerTools) {
    assert.equal(
      /(shell|exec|spawn|supervisor|vm_input|keystroke|mouse|host_command)/i.test(tool.name),
      false,
      `unexpected privileged Router tool: ${tool.name}`,
    );
  }
  passed("Router 工具面不包含宿主命令、Shell 或 VM 输入能力", `${routerTools.length} tools`);

  // Seed directly into the live WAL database, then SIGKILL the control plane.
  // This exercises the real crash path instead of a graceful shutdown.
  const expectedTasks = await seedFailureAndPerformanceFixtures();
  await crashControlPlane();
  passed("控制平面在运行任务状态下被 SIGKILL，Fixture 与待应用迁移已持久化");

  await startControlPlane();
  const backupFile = await latestBackupFile();
  const classes = await loadControlPlaneClasses();
  await classes.inspectMigrationBackup(backupFile);
  const backupHash = await classes.sha256File(backupFile);
  const sidecar = await readFile(`${backupFile}.sha256`, "utf8");
  assert.match(sidecar, new RegExp(backupHash));
  assert.match(path.basename(backupFile), /011_phase12_hardening/);
  const afterMigration = await api<DiagnosticsReport>("/api/v1/diagnostics");
  assert.equal(afterMigration.database.pendingMigrations.length, 0);
  assert.ok(afterMigration.database.migrationBackups.length >= 1);
  passed(
    "迁移前数据库备份先通过完整性校验并写入 SHA-256，再应用迁移",
    path.basename(backupFile),
  );

  const runningTask = await api<TaskDetail>(`/api/v1/tasks/${runningTaskId}`);
  assert.equal(runningTask.task.status, "failed");
  assert.equal(runningTask.task.errorCode, "worker_runtime_restarted");
  assert.equal(runningTask.task.attemptCount, 1);
  assert.ok(
    runningTask.events.some((event) => event.type === "worker.runtime_restarted"),
    "restart event missing",
  );
  const worker = await api<{
    worker: { status: string; currentTaskId: string | null; lastErrorCode: string | null };
  }>(`/api/v1/workers/${workerId}`);
  assert.equal(worker.worker.status, "failed");
  assert.equal(worker.worker.currentTaskId, null);
  assert.equal(worker.worker.lastErrorCode, "control_plane_restarted");
  const control = await api<{ lease: unknown }>(`/api/v1/vms/${vmId}/control`);
  assert.equal(control.lease, null);
  passed("控制平面崩溃后运行任务安全失败、Worker 对账、Lease 释放且不盲目重放");

  const boardStarted = Date.now();
  const board = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  const boardMs = Date.now() - boardStarted;
  assert.ok(board.tasks.length >= expectedTasks);
  assert.ok(boardMs < 5000, `board took ${boardMs} ms`);
  metrics.boardTaskCount = board.tasks.length;
  metrics.boardMs = boardMs;
  const routerStarted = Date.now();
  const routerMessages = await api<RouterMessageRecord[]>("/api/v1/router/messages?limit=100");
  const routerMs = Date.now() - routerStarted;
  assert.equal(routerMessages.length, 100);
  assert.ok(routerMs < 3000, `router messages took ${routerMs} ms`);
  metrics.routerMessages = routerMessages.length;
  metrics.routerMessagesMs = routerMs;
  passed(
    "大任务历史看板与 Router 消息查询保持可用",
    `${board.tasks.length} tasks / ${boardMs} ms; router ${routerMs} ms`,
  );

  await stopChild(controlPlane);
  controlPlane = undefined;
  for (const suffix of ["-wal", "-shm"]) {
    await rm(`${databaseFile}${suffix}`, { force: true });
  }
  await cp(backupFile, databaseFile);
  passed("停止控制平面后用迁移前备份重建主数据库，模拟备份恢复流程");

  await startControlPlane();
  const restoredProject = await api<ProjectDetail>(`/api/v1/projects/${projectId}`);
  assert.equal(restoredProject.project.name, "Phase 12 acceptance project");
  const restoredTask = await api<TaskDetail>(`/api/v1/tasks/${runningTaskId}`);
  assert.equal(restoredTask.task.id, runningTaskId);
  const restoredBoard = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  assert.ok(restoredBoard.tasks.length >= expectedTasks);
  metrics.restoredTaskCount = restoredBoard.tasks.length;
  metrics.preMigrationBackup = path.basename(backupFile);
  passed(
    "备份可恢复：项目、任务历史和迁移记录在恢复后重新可用",
    `${restoredBoard.tasks.length} tasks`,
  );

  await stopChild(controlPlane);
  controlPlane = undefined;

  const result = {
    phase: 12,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    metrics,
    boundaries: {
      realQemuWxpx: false,
      realLinuxGuest: false,
      realPiProcess: false,
      realRouterPi: false,
      realModel: false,
      realFeishuApp: false,
      realQqBot: false,
      realBrowserUi: false,
      realElectronUi: false,
      windowsNsisInstall: false,
      realAutoUpdateFeed: false,
      longSoak: false,
    },
    note: "真实控制平面、SQLite、迁移备份/恢复、崩溃对账、静态 Web 构建和 2000+ 任务历史；未执行真实 QEMU/WHPX Linux VM、真实 Pi/模型、真实机器人、真实更新源、Windows 安装包或长时稳定性验收。",
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Phase 12 smoke passed ${checks.length} checks. Result: ${resultPath}`);
} finally {
  clearTimeout(watchdog);
  for (const child of children) await stopChild(child);
  if (!process.env.AGENT_IN_BOX_PHASE12_KEEP) {
    await rm(temporary, { recursive: true, force: true });
  }
}
