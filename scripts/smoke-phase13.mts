import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ImageCatalog,
  ProjectDetail,
  TaskBoardSnapshot,
  TaskCreateResult,
} from "@agent-in-box/protocol";
import { smokeAuthHeaders } from "./smoke-auth.mjs";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface DbHandle {
  db: unknown;
  close(): Promise<void>;
}

interface Classes {
  AppDatabase: {
    open(options: { filename: string }): DbHandle & { migrate(): Promise<string[]> };
  };
  CatalogRepository: new (db: unknown) => {
    createVm(input: Record<string, unknown>): Promise<{ id: string }>;
  };
  TaskRepository: new (db: unknown) => unknown;
  OutboxRepository: new (db: unknown) => unknown;
  WorkerRepository: new (db: unknown) => unknown;
  WorkerArchiveRepository: new (db: unknown) => unknown;
  TaskService: new (
    db: unknown,
    tasks: unknown,
    outbox: unknown,
  ) => {
    claimNext(vmId: string, workerId?: string): Promise<{ id: string } | null>;
    board(): Promise<TaskBoardSnapshot>;
  };
  WorkerRegistryService: new (
    db: unknown,
    workers: unknown,
    archives: unknown,
    tasks: unknown,
    outbox: unknown,
  ) => unknown;
  RouterToolService: new (
    db: unknown,
    tasks: unknown,
    registry: unknown,
    workers: unknown,
  ) => {
    execute(
      name: string,
      args: Record<string, unknown>,
      context: { conversationId: string },
    ): Promise<unknown>;
  };
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase13-"));
const configDirectory = path.join(temporary, "config");
const databaseFile = path.join(temporary, "agent-in-box.sqlite");
const manifestFile = path.join(temporary, "image-manifest.json");
const resultPath =
  process.env.AGENT_IN_BOX_PHASE13_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase13/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );

const controlPlanePort = await freePort();
const baseUrl = `http://127.0.0.1:${controlPlanePort}`;
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const startedAt = new Date().toISOString();
const metrics: Record<string, number | string | boolean> = {};

const linuxImageId = "phase13-linux-image";
const windowsImageId = "phase13-windows-image";
let controlPlane: ChildProcess | undefined;
let database: DbHandle | undefined;
let projectId = "";
let linuxVmId = "";
let windowsVmId = "";

const watchdog = setTimeout(() => {
  console.error(`phase13 smoke watchdog timeout after ${checks.length} checks`);
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

function distUrl(module: string): string {
  return pathToFileURL(path.join(repository, "services/control-plane/dist", module)).href;
}

async function loadClasses(): Promise<Classes> {
  const [
    databaseModule,
    catalogRepository,
    taskRepository,
    outboxRepository,
    workerRepository,
    workerArchiveRepository,
    taskService,
    workerRegistry,
    routerTool,
  ] = await Promise.all([
    import(distUrl("persistence/database.js")),
    import(distUrl("persistence/repositories/catalog-repository.js")),
    import(distUrl("persistence/repositories/task-repository.js")),
    import(distUrl("persistence/repositories/outbox-repository.js")),
    import(distUrl("persistence/repositories/worker-repository.js")),
    import(distUrl("persistence/repositories/worker-archive-repository.js")),
    import(distUrl("persistence/services/task-service.js")),
    import(distUrl("workers/worker-registry.service.js")),
    import(distUrl("router/router-tool.service.js")),
  ]);
  return {
    AppDatabase: databaseModule.AppDatabase,
    CatalogRepository: catalogRepository.CatalogRepository,
    TaskRepository: taskRepository.TaskRepository,
    OutboxRepository: outboxRepository.OutboxRepository,
    WorkerRepository: workerRepository.WorkerRepository,
    WorkerArchiveRepository: workerArchiveRepository.WorkerArchiveRepository,
    TaskService: taskService.TaskService,
    WorkerRegistryService: workerRegistry.WorkerRegistryService,
    RouterToolService: routerTool.RouterToolService,
  };
}

async function buildGuestAgent(): Promise<string> {
  const executable = path.join(
    temporary,
    process.platform === "win32" ? "guest-agent.exe" : "guest-agent",
  );
  const result = spawnSync(
    "go",
    ["build", "-o", executable, "./services/guest-agent/cmd/guest-agent"],
    { cwd: repository, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("failed to build the Guest Agent for phase13 smoke");
  return executable;
}

async function startGuestAgent(): Promise<{
  port: number;
  token: string;
  root: string;
  process: ChildProcess;
}> {
  const executable = await buildGuestAgent();
  const root = path.join(temporary, "guest-roots");
  await mkdir(root, { recursive: true });
  const token = "phase13-guest-token-0123456789abcdef0123456789abcdef";
  const tokenFile = path.join(temporary, "guest-agent.token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(
    executable,
    [
      "-addr",
      `127.0.0.1:${port}`,
      "-token-file",
      tokenFile,
      "-verify-roots",
      root,
      "-workspace-roots",
      root,
      "-update-dir",
      path.join(temporary, "updates"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`guest agent exited early (${child.exitCode}): ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return { port, token, root, process: child };
    } catch {
      // Retry while the listener binds.
    }
    await delay(100);
  }
  throw new Error(`guest agent did not become healthy: ${stderr}`);
}

function guestHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function guestJson(port: number, route: string, token?: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: token ? guestHeaders(token) : {},
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function controlPlaneEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTROL_PLANE_HOST: "127.0.0.1",
    CONTROL_PLANE_PORT: String(controlPlanePort),
    AGENT_IN_BOX_DATA_ROOT: temporary,
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    AGENT_IN_BOX_WEB_ROOT: path.join(repository, "apps", "web", "dist"),
    AGENT_IN_BOX_IMAGE_MANIFEST: manifestFile,
    AGENT_IN_BOX_RESOURCE_TICK_MS: "600000",
    AGENT_IN_BOX_NOTIFICATION_TICK_MS: "100",
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
      // Retry while Nest binds.
    }
    await delay(100);
  }
  throw new Error("control plane did not become healthy");
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...smokeAuthHeaders(configDirectory), ...extra };
}

async function api<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...bearerHeaders(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function writeManifest(): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    allowedHosts: ["images.example.test"],
    images: [
      {
        id: linuxImageId,
        name: "Phase 13 Linux image",
        osFamily: "linux",
        osVersion: "24.04",
        architecture: "amd64",
        version: "phase13",
        url: "https://images.example.test/linux.qcow2",
        fileName: "phase13-linux.qcow2",
        sizeBytes: 0,
        sha256: "a".repeat(64),
      },
      {
        id: windowsImageId,
        name: "Phase 13 Windows image",
        osFamily: "windows",
        osVersion: "11",
        architecture: "amd64",
        version: "phase13",
        url: "https://images.example.test/windows.qcow2",
        fileName: "phase13-windows.qcow2",
        sizeBytes: 0,
        sha256: "b".repeat(64),
      },
    ],
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function seedVms(classes: Classes): Promise<void> {
  const handle = classes.AppDatabase.open({ filename: databaseFile });
  await handle.migrate();
  database = handle;
  const db = handle.db;
  const catalog = new classes.CatalogRepository(db);
  const linux = await catalog.createVm({
    name: "Phase 13 Linux VM",
    imageId: linuxImageId,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 40 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "linux"),
  });
  const windows = await catalog.createVm({
    name: "Phase 13 Windows VM",
    imageId: windowsImageId,
    osFamily: "windows",
    cpuCount: 4,
    memoryBytes: 8 * 1024 ** 3,
    diskBytes: 64 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "windows"),
  });
  linuxVmId = linux.id;
  windowsVmId = windows.id;
  for (const vmId of [linuxVmId, windowsVmId]) {
    await (
      db as {
        updateTable(table: string): {
          set(values: unknown): {
            where(column: string, operator: string, value: string): { execute(): Promise<void> };
          };
        };
      }
    )
      .updateTable("vm_instances")
      .set({ power_state: "running", guest_health: "healthy" })
      .where("id", "=", vmId)
      .execute();
  }
}

async function createTask(vmId: string, objective: string): Promise<string> {
  const result = await api<TaskCreateResult>("/api/v1/tasks", {
    method: "POST",
    headers: { "x-idempotency-key": randomUUID() },
    body: JSON.stringify({ projectId, vmId, objective }),
  });
  assert.equal(result.status, 201);
  return result.body.task.id;
}

try {
  await writeManifest();

  const guest = await startGuestAgent();
  const unauthenticated = (await guestJson(guest.port, "/v1/capabilities")) as {
    status: number;
  };
  assert.equal(unauthenticated.status, 401);
  const capabilities = (await guestJson(guest.port, "/v1/capabilities", guest.token)) as {
    status: number;
    body: {
      platform: string;
      displayServer: string;
      screenshot: boolean;
      input: boolean;
      unicodeInput: boolean;
      sessionState?: string;
    };
  };
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.platform, process.platform === "win32" ? "windows" : "linux");
  metrics.guestPlatform = capabilities.body.platform;
  metrics.guestDisplayServer = capabilities.body.displayServer || "unavailable";
  passed(
    "真实 Guest Agent 进程启动、未认证请求被拒绝、平台与能力可读取",
    `${capabilities.body.platform}/${capabilities.body.displayServer || "no-desktop"}`,
  );

  const processName = path.basename(process.execPath);
  const verifyResponse = await fetch(`http://127.0.0.1:${guest.port}/v1/verify`, {
    method: "POST",
    headers: { ...guestHeaders(guest.token), "content-type": "application/json" },
    body: JSON.stringify({ checks: [{ type: "process", name: processName }] }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(verifyResponse.status, 200);
  const verify = (await verifyResponse.json()) as {
    ok: boolean;
    checks: Array<{ ok: boolean; pids?: number[] }>;
  };
  assert.equal(verify.ok, true);
  assert.ok((verify.checks[0]?.pids?.length ?? 0) > 0);
  passed("Guest 只读进程证据在 Windows/Linux 上返回真实 PID", processName);

  const workspace = path.join(guest.root, "workspace");
  await mkdir(path.join(workspace, "nested"), { recursive: true });
  await writeFile(path.join(workspace, "nested", "evidence.txt"), "phase13-workspace\n");
  const archiveResponse = await fetch(
    `http://127.0.0.1:${guest.port}/v1/workspace/archive?path=${encodeURIComponent(workspace)}`,
    { headers: guestHeaders(guest.token), signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(archiveResponse.status, 200);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const archiveSha = archiveResponse.headers.get("x-agent-in-box-sha256") ?? "";
  assert.match(archiveSha, /^[a-f0-9]{64}$/);
  assert.ok(archive.byteLength > 0);
  const restored = path.join(guest.root, "restored");
  const restoreResponse = await fetch(
    `http://127.0.0.1:${guest.port}/v1/workspace/restore?path=${encodeURIComponent(restored)}`,
    {
      method: "POST",
      headers: {
        ...guestHeaders(guest.token),
        "content-type": "application/gzip",
        "x-agent-in-box-sha256": archiveSha,
      },
      body: archive,
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(restoreResponse.status, 200);
  const restore = (await restoreResponse.json()) as { fileCount: number };
  assert.ok(restore.fileCount >= 1);
  assert.equal(
    await readFile(path.join(restored, "nested", "evidence.txt"), "utf8"),
    "phase13-workspace\n",
  );
  metrics.workspaceArchiveBytes = archive.byteLength;
  passed("Guest workspace 归档/恢复在 Windows/Linux 路径上完成 SHA-256 校验往返");

  const tokenScript = path.join(repository, "scripts", "provision-guest-tokens.mjs");
  const tokenVm = path.join(temporary, "token-vm");
  const tokenMedium = path.join(temporary, "token-medium");
  const tokenRun = spawnSync(
    process.execPath,
    [tokenScript, "--vm-storage", tokenVm, "--token-dir", tokenMedium],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(tokenRun.status, 0, tokenRun.stderr);
  for (const name of ["guest-agent.token", "worker-rpc.token"]) {
    const hostValue = (await readFile(path.join(tokenVm, name), "utf8")).trim();
    const mediumValue = (await readFile(path.join(tokenMedium, name), "utf8")).trim();
    assert.ok(hostValue.length >= 32);
    assert.equal(hostValue, mediumValue);
  }
  const overwrite = spawnSync(
    process.execPath,
    [tokenScript, "--vm-storage", tokenVm, "--token-dir", tokenMedium],
    { cwd: repository, encoding: "utf8" },
  );
  assert.notEqual(overwrite.status, 0);
  passed("每 VM Guest/RPC token 生成可复现，默认拒绝覆盖已有 token");

  await startControlPlane();
  const health = await fetch(`${baseUrl}/api/v1/health`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(health.status, 200);
  passed("真实控制平面以自定义镜像 Manifest 启动并保持回环可用");

  const images = await api<ImageCatalog>("/api/v1/images");
  assert.equal(images.status, 200);
  const imageIds = images.body.items.map((image) => image.id);
  assert.ok(imageIds.includes(linuxImageId));
  assert.ok(imageIds.includes(windowsImageId));
  passed("Image Service 同时接受 Linux 与 Windows Manifest 条目");

  const classes = await loadClasses();
  await seedVms(classes);

  const project = await api<ProjectDetail>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "Phase 13 mixed OS project",
      description: "Linux/Windows mixed scheduling",
      workspaceConfig: { defaultGuestWorkspacePath: "C:\\Users\\aib-worker\\workspace" },
    }),
  });
  assert.equal(project.status, 201);
  projectId = project.body.project.id;
  const linuxBinding = await api<ProjectDetail>(`/api/v1/projects/${projectId}/bindings`, {
    method: "POST",
    body: JSON.stringify({
      vmId: linuxVmId,
      guestWorkspacePath: "/home/aib-worker/workspace",
      isPrimary: true,
    }),
  });
  assert.equal(linuxBinding.status, 201);
  const windowsBinding = await api<ProjectDetail>(`/api/v1/projects/${projectId}/bindings`, {
    method: "POST",
    body: JSON.stringify({
      vmId: windowsVmId,
      guestWorkspacePath: "C:\\Users\\aib-worker\\workspace",
      isPrimary: false,
    }),
  });
  assert.equal(windowsBinding.status, 201);
  assert.equal(windowsBinding.body.bindings.length, 2);
  assert.deepEqual(windowsBinding.body.bindings.map((binding) => binding.vm.osFamily).sort(), [
    "linux",
    "windows",
  ]);
  assert.ok(
    windowsBinding.body.bindings.some(
      (binding) => binding.binding.guestWorkspacePath === "C:\\Users\\aib-worker\\workspace",
    ),
  );
  passed("HTTP 项目创建与双 OS 绑定接受 Windows 绝对工作目录");

  const invalidProject = await api<unknown>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "Invalid Windows path",
      workspaceConfig: { defaultGuestWorkspacePath: "C:\\Users\\..\\Windows" },
    }),
  });
  assert.equal(invalidProject.status, 400);
  const windowsBindingId = windowsBinding.body.bindings.find(
    (binding) => binding.vm.id === windowsVmId,
  )?.binding.id;
  assert.ok(windowsBindingId);
  const invalidBinding = await api<unknown>(
    `/api/v1/projects/${projectId}/bindings/${windowsBindingId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ guestWorkspacePath: "C:\\work:stream" }),
    },
  );
  assert.equal(invalidBinding.status, 400);
  passed("Windows 父目录穿越与 NTFS 数据流路径在 HTTP 边界被拒绝");

  const linuxFirst = await createTask(linuxVmId, "Linux task one");
  const linuxSecond = await createTask(linuxVmId, "Linux task two");
  const windowsFirst = await createTask(windowsVmId, "Windows task one");
  const windowsSecond = await createTask(windowsVmId, "Windows task two");

  const handle = database!;
  const tasks = new classes.TaskService(
    handle.db,
    new classes.TaskRepository(handle.db),
    new classes.OutboxRepository(handle.db),
  );
  const claimedLinux = await tasks.claimNext(linuxVmId);
  const claimedWindows = await tasks.claimNext(windowsVmId);
  assert.ok(claimedLinux);
  assert.ok(claimedWindows);
  assert.notEqual(claimedLinux.id, claimedWindows.id);
  assert.equal(await tasks.claimNext(linuxVmId), null);
  assert.equal(await tasks.claimNext(windowsVmId), null);
  const board = await tasks.board();
  const running = board.tasks.filter((task) => task.status === "running");
  const queued = board.tasks.filter((task) => task.status === "queued");
  assert.equal(running.length, 2);
  assert.equal(queued.length, 2);
  assert.ok(
    board.tasks.every((task) =>
      task.vmId === linuxVmId ? task.vmOsFamily === "linux" : task.vmOsFamily === "windows",
    ),
  );
  assert.ok(
    [linuxFirst, linuxSecond, windowsFirst, windowsSecond].every((taskId) =>
      board.tasks.some((task) => task.id === taskId),
    ),
  );
  metrics.mixedTaskCount = board.tasks.length;
  passed(
    "跨 VM 并行、同 VM 串行：两个 Guest 各运行一个任务，其余同 VM 任务保持排队",
    `${running.length} running / ${queued.length} queued`,
  );

  const boardResponse = await api<TaskBoardSnapshot>("/api/v1/tasks/board");
  assert.equal(boardResponse.status, 200);
  assert.ok(
    boardResponse.body.tasks.every(
      (task) => task.vmOsFamily === "linux" || task.vmOsFamily === "windows",
    ),
  );
  passed("任务看板对混合任务返回目标 Guest OS，Web/Electron 使用同一快照");

  const registry = new classes.WorkerRegistryService(
    handle.db,
    new classes.WorkerRepository(handle.db),
    new classes.WorkerArchiveRepository(handle.db),
    tasks,
    new classes.OutboxRepository(handle.db),
  );
  const router = new classes.RouterToolService(handle.db, tasks, registry, {} as never);
  const projects = (await router.execute(
    "list_projects",
    {},
    { conversationId: "phase13-router" },
  )) as Array<{
    projectId: string;
    bindings: Array<{ vmId: string; osFamily: string }>;
  }>;
  const mixedProject = projects.find((item) => item.projectId === projectId);
  assert.ok(mixedProject);
  assert.deepEqual(mixedProject.bindings.map((binding) => binding.osFamily).sort(), [
    "linux",
    "windows",
  ]);
  const summary = (await router.execute(
    "get_board_summary",
    {},
    { conversationId: "phase13-router" },
  )) as {
    vms: Array<{ vmId: string; osFamily: string; queuedTaskCount: number }>;
  };
  const summaryByVm = new Map(summary.vms.map((vm) => [vm.vmId, vm]));
  assert.equal(summaryByVm.get(linuxVmId)?.osFamily, "linux");
  assert.equal(summaryByVm.get(windowsVmId)?.osFamily, "windows");
  assert.equal(summaryByVm.get(linuxVmId)?.queuedTaskCount, 1);
  assert.equal(summaryByVm.get(windowsVmId)?.queuedTaskCount, 1);
  passed("Router 工具面能看到项目绑定的 Guest OS 与每 VM 队列，不含宿主执行能力");

  const windowsAssets = [
    "README.md",
    "manifest.example.json",
    "unattend/autounattend.xml.example",
    "scripts/build-golden-image.ps1",
    "guest-runtime/install.ps1",
    "guest-runtime/Install-FromProvisioning.ps1",
    "guest-runtime/Start-GuestAgent.ps1",
    "guest-runtime/Start-Worker.ps1",
    "guest-runtime/Provision-Tokens.ps1",
  ];
  for (const asset of windowsAssets) {
    await readFile(path.join(repository, "images/windows", asset));
  }
  const linuxExtension = await readFile(
    path.join(repository, "images/linux/worker-runtime/cua-extension.js"),
  );
  const windowsExtension = await readFile(
    path.join(repository, "images/windows/guest-runtime/cua-extension.js"),
  );
  assert.ok(linuxExtension.equals(windowsExtension));
  const exampleManifest = JSON.parse(
    await readFile(path.join(repository, "images/windows/manifest.example.json"), "utf8"),
  ) as { images: Array<{ osFamily: string }> };
  assert.ok(exampleManifest.images.some((image) => image.osFamily === "windows"));
  passed("Windows Golden Image、无人值守、Guest Runtime 与镜像 Manifest 资产齐全且扩展一致");

  const result = {
    phase: 13,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    metrics,
    boundaries: {
      realQemuWxpxWindowsGuest: false,
      realWindowsIsoBuild: false,
      realWindowsDesktopCapture: false,
      realWindowsUnicodeInput: false,
      realWindowsUacSecureDesktop: false,
      realWindowsPiProcess: false,
      realWindowsModel: false,
      realWindowsMultiMonitorDpi: false,
      realFeishuApp: false,
      realQqBot: false,
      realBrowserUi: false,
      realElectronUi: false,
      windowsNsisInstall: false,
      longSoak: false,
    },
    note: "真实控制平面、SQLite、Guest Agent 进程/认证/进程证据/workspace 往返、Windows/Linux 混合项目与调度；未执行真实 Windows ISO 安装、真实 WHPX Windows Guest、真实 Windows 截图/输入/UAC/DPI、真实 Pi/模型或安装包验收。",
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Phase 13 smoke passed ${checks.length} checks. Result: ${resultPath}`);
} finally {
  clearTimeout(watchdog);
  for (const child of children) await stopChild(child);
  await database?.close().catch(() => undefined);
  if (!process.env.AGENT_IN_BOX_PHASE13_KEEP) {
    await rm(temporary, { recursive: true, force: true });
  }
}
