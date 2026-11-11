import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { smokeAccessKey } from "./smoke-auth.mjs";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase11-"));
const configDirectory = path.join(temporary, "config");
const resultPath =
  process.env.AGENT_IN_BOX_PHASE11_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase11/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const startedAt = new Date().toISOString();
const controlPlanePort = await freePort();
const baseUrl = `http://127.0.0.1:${controlPlanePort}`;
let controlPlane: ChildProcess | undefined;
let projectId = "";
const watchdog = setTimeout(() => {
  console.error(`phase11 smoke watchdog timeout after ${checks.length} checks`);
  for (const child of children) child.kill("SIGKILL");
  process.exit(2);
}, 180_000);

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
  const done = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
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
    AGENT_IN_BOX_INBOX_MAX_BYTES: "1024",
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
      // Retry.
    }
    await delay(100);
  }
  throw new Error("control plane did not become healthy");
}

function accessKey(): string {
  return smokeAccessKey(configDirectory);
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${accessKey()}`, ...extra };
}

async function request(
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
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

interface SessionCookie {
  cookie: string;
  csrfToken: string;
}

async function login(): Promise<SessionCookie> {
  const response = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: accessKey(), label: "phase11-smoke" }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0]!;
  const body = response.body as { csrfToken?: string };
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken };
}

async function seedProject(): Promise<void> {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );
  const database = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await database.migrate();
  const catalog = new CatalogRepository(database.db);
  const project = await catalog.createProject({
    name: "Phase 11 project",
    description: "Local web / notification smoke",
  });
  projectId = project.id;
  await database.close();
}

async function createNotificationTask(): Promise<string> {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { TaskRepository } = await import(dist("persistence/repositories/task-repository.js"));
  const { OutboxRepository } = await import(
    dist("persistence/repositories/outbox-repository.js")
  );
  const { TaskService } = await import(dist("persistence/services/task-service.js"));
  const database = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  try {
    const tasks = new TaskService(
      database.db,
      new TaskRepository(database.db),
      new OutboxRepository(database.db),
    );
    const vmId = (await database.db.selectFrom("vm_instances").select("id").executeTakeFirst())
      ?.id;
    if (!vmId) throw new Error("seeded VM missing");
    const conversation = await database.db
      .selectFrom("conversations")
      .select("id")
      .executeTakeFirst();
    let conversationId = conversation?.id;
    if (!conversationId) {
      const { randomUUID } = await import("node:crypto");
      conversationId = randomUUID();
      const now = new Date().toISOString();
      await database.db
        .insertInto("conversations")
        .values({
          id: conversationId,
          kind: "project",
          project_id: projectId,
          title: "Phase 11 smoke conversation",
          created_at: now,
          last_message_at: now,
        })
        .execute();
    }
    const { task } = await tasks.create({
      projectId,
      vmId,
      originConversationId: conversationId,
      objective: "Phase 11 notification smoke",
      idempotencyKey: "phase11-notification",
    });
    return task.id;
  } finally {
    await database.close();
  }
}

async function seedVm(): Promise<void> {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );
  const database = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  try {
    const catalog = new CatalogRepository(database.db);
    const image = await catalog.createImage({
      name: "Phase 11 Linux",
      osFamily: "linux",
      osVersion: "24.04",
      architecture: "amd64",
      version: "phase11",
      sizeBytes: 1,
      checksum: "0".repeat(64),
      localPath: path.join(temporary, "images", "phase11.qcow2"),
    });
    const vm = await catalog.createVm({
      name: "Phase 11 VM",
      imageId: image.id,
      osFamily: "linux",
      cpuCount: 2,
      memoryBytes: 2 * 1024 ** 3,
      diskBytes: 20 * 1024 ** 3,
      storageRoot: path.join(temporary, "vms", "phase11"),
    });
    await catalog.bindVm({
      projectId,
      vmId: vm.id,
      guestWorkspacePath: "/home/worker/workspace",
      isPrimary: true,
    });
  } finally {
    await database.close();
  }
}

async function waitForNotification(
  cookie: SessionCookie,
  taskId: string,
): Promise<{ id: string; title: string; unreadCount: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request("/api/v1/notifications", {
      headers: { cookie: cookie.cookie },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body as {
      items: Array<{ id: string; title: string; taskId: string | null }>;
      unreadCount: number;
    };
    const item = body.items.find((candidate) => candidate.taskId === taskId);
    if (item) return { id: item.id, title: item.title, unreadCount: body.unreadCount };
    await delay(100);
  }
  throw new Error("notification was not projected");
}

const webSocketPath = pathToFileURL(
  path.join(repository, "services/control-plane/node_modules/ws/wrapper.mjs"),
).href;

try {
  await mkdir(configDirectory, { recursive: true });
  await seedProject();
  await seedVm();
  await startControlPlane();
  passed("控制平面启动并保持回环监听");

  const staticIndex = await request("/");
  assert.equal(staticIndex.status, 200);
  assert.match(String(staticIndex.body), /<div id="root">/);
  assert.match(staticIndex.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(staticIndex.headers.get("x-frame-options"), "DENY");
  assert.equal(staticIndex.headers.get("access-control-allow-origin"), null);
  passed("静态 Web 可加载，CSP/安全头生效且没有宽松 CORS");

  const anonymousOnboarding = await request("/api/v1/onboarding");
  assert.equal(anonymousOnboarding.status, 401);
  const anonymousSession = await request("/api/v1/auth/session");
  assert.equal(anonymousSession.status, 200);
  assert.equal((anonymousSession.body as { state: string }).state, "anonymous");
  passed("仅绑定本机地址不等于免认证：未登录 API 返回 401");

  const wrongLogin = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: "aib_wrong_key_value" }),
  });
  assert.equal(wrongLogin.status, 401);
  const cookie = await login();
  const authenticated = await request("/api/v1/auth/session", {
    headers: { cookie: cookie.cookie },
  });
  assert.equal((authenticated.body as { state: string }).state, "authenticated");
  passed("错误密钥被拒绝，正确密钥建立 HttpOnly + SameSite=Strict 会话");

  const noCsrf = await request("/api/v1/settings", {
    method: "PATCH",
    headers: { cookie: cookie.cookie, "content-type": "application/json" },
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: false } }),
  });
  assert.equal(noCsrf.status, 403);
  const wrongCsrf = await request("/api/v1/settings", {
    method: "PATCH",
    headers: {
      cookie: cookie.cookie,
      "content-type": "application/json",
      "x-agent-in-box-csrf": "wrong",
    },
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: false } }),
  });
  assert.equal(wrongCsrf.status, 403);
  const goodCsrf = await request("/api/v1/settings", {
    method: "PATCH",
    headers: {
      cookie: cookie.cookie,
      "content-type": "application/json",
      "x-agent-in-box-csrf": cookie.csrfToken,
    },
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: false } }),
  });
  assert.equal(goodCsrf.status, 200, JSON.stringify(goodCsrf.body));
  passed("Cookie 会话的写操作必须携带会话绑定的 CSRF 令牌");

  const crossOrigin = await request("/api/v1/settings", {
    method: "PATCH",
    headers: {
      cookie: cookie.cookie,
      "content-type": "application/json",
      origin: "http://127.0.0.1:9999",
      "x-agent-in-box-csrf": cookie.csrfToken,
    },
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: false } }),
  });
  assert.equal(crossOrigin.status, 403);
  const sameSiteFetch = await request("/api/v1/settings", {
    method: "PATCH",
    headers: {
      cookie: cookie.cookie,
      "content-type": "application/json",
      "sec-fetch-site": "same-site",
      "x-agent-in-box-csrf": cookie.csrfToken,
    },
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: false } }),
  });
  assert.equal(sameSiteFetch.status, 403);
  const bearerPatch = await request("/api/v1/settings", {
    method: "PATCH",
    headers: bearerHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ security: { requireApprovalForSensitiveActions: true } }),
  });
  assert.equal(bearerPatch.status, 200);
  passed("跨端口 Origin、same-site 浏览器请求被拒绝；显式 Bearer 密钥可用于本机自动化");

  const { WebSocket } = await import(webSocketPath);
  const eventMessages: Array<Record<string, unknown>> = [];
  const eventSocket = new WebSocket(`ws://127.0.0.1:${controlPlanePort}/api/v1/events/ws`, {
    origin: baseUrl,
    headers: { cookie: cookie.cookie },
  });
  eventSocket.on("message", (data: Buffer) =>
    eventMessages.push(JSON.parse(String(data)) as Record<string, unknown>),
  );
  await once(eventSocket, "open");
  await delay(200);
  assert.ok(eventMessages.some((message) => message.type === "ready"));
  eventSocket.close();
  const anonymousSocket = new WebSocket(`ws://127.0.0.1:${controlPlanePort}/api/v1/events/ws`, {
    origin: baseUrl,
  });
  const [socketError] = (await once(anonymousSocket, "error")) as [Error];
  assert.match(socketError.message, /401/);
  passed("事件 WebSocket 需要有效会话，匿名同源连接返回 401");

  const taskId = await createNotificationTask();
  const notification = await waitForNotification(cookie, taskId);
  assert.match(notification.title, /新任务/);
  assert.ok(notification.unreadCount >= 1);
  await delay(300);
  const stable = await request("/api/v1/notifications", {
    headers: { cookie: cookie.cookie },
  });
  const stableItems = (stable.body as { items: Array<{ taskId: string | null }> }).items.filter(
    (item) => item.taskId === taskId,
  );
  assert.equal(stableItems.length, 1, "notification.created must not be projected recursively");
  const marked = await request(`/api/v1/notifications/${notification.id}/read`, {
    method: "POST",
    headers: {
      cookie: cookie.cookie,
      "content-type": "application/json",
      "x-agent-in-box-csrf": cookie.csrfToken,
    },
    body: "{}",
  });
  assert.equal(marked.status, 200);
  const afterRead = (await request("/api/v1/notifications", {
    headers: { cookie: cookie.cookie },
  })).body as { unreadCount: number };
  assert.equal(afterRead.unreadCount, 0);
  const dismissed = await request(`/api/v1/notifications/${notification.id}/dismiss`, {
    method: "POST",
    headers: bearerHeaders({ "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(dismissed.status, 200);
  passed("Outbox 投影到统一通知中心、只投影一次，并支持已读/移除");

  const uploadBody = Buffer.from("hello phase11");
  const upload = await request("/api/v1/inbox/upload", {
    method: "POST",
    headers: bearerHeaders({
      "x-file-name": encodeURIComponent("周报 2026.txt"),
      "x-project-id": projectId,
      "content-type": "text/plain",
      "content-length": String(uploadBody.length),
    }),
    body: uploadBody,
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const uploaded = upload.body as { id: string; originalName: string; sha256: string };
  assert.equal(uploaded.originalName, "周报 2026.txt");
  assert.equal(uploaded.sha256, createHash("sha256").update(uploadBody).digest("hex"));
  const list = (await request(`/api/v1/inbox?projectId=${projectId}`, {
    headers: bearerHeaders(),
  })).body as { items: Array<{ id: string }> };
  assert.equal(list.items.length, 1);
  const download = await fetch(`${baseUrl}/api/v1/inbox/${uploaded.id}/content`, {
    headers: bearerHeaders(),
  });
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString("utf8"), "hello phase11");
  const traversal = await request("/api/v1/inbox/upload", {
    method: "POST",
    headers: bearerHeaders({
      "x-file-name": encodeURIComponent("../../etc/passwd"),
      "content-type": "text/plain",
    }),
    body: Buffer.from("safe"),
  });
  assert.equal((traversal.body as { originalName: string }).originalName, "passwd");
  const oversized = await request("/api/v1/inbox/upload", {
    method: "POST",
    headers: bearerHeaders({
      "x-file-name": "large.bin",
      "content-type": "application/octet-stream",
      "content-length": "2048",
    }),
    body: Buffer.alloc(2048, 1),
  });
  assert.equal(oversized.status, 400);
  const deleted = await request(`/api/v1/inbox/${uploaded.id}`, {
    method: "DELETE",
    headers: bearerHeaders(),
  });
  assert.equal(deleted.status, 200);
  passed("文件拖放上传经过命名清洗、大小限制、SHA-256 记录、下载和删除");

  await stopChild(controlPlane);
  await startControlPlane();
  const afterRestart = await request("/api/v1/auth/session", {
    headers: { cookie: cookie.cookie },
  });
  assert.equal((afterRestart.body as { state: string }).state, "authenticated");
  const persistedNotification = await request("/api/v1/notifications", {
    headers: { cookie: cookie.cookie },
  });
  assert.equal(persistedNotification.status, 200);
  passed("控制平面重启后 SQLite 会话与通知游标仍然有效");

  const rotate = await request("/api/v1/auth/rotate", {
    method: "POST",
    headers: bearerHeaders({ "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(rotate.status, 200, JSON.stringify(rotate.body));
  const oldCookieSession = await request("/api/v1/auth/session", {
    headers: { cookie: cookie.cookie },
  });
  assert.equal((oldCookieSession.body as { state: string }).state, "anonymous");
  const oldKey = await request("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${accessKey()}` },
  });
  assert.equal(oldKey.status, 200);
  passed("更换访问密钥后旧密钥和旧会话失效，新密钥立即可用");

  let rateLimited = false;
  for (let index = 0; index < 8; index += 1) {
    const attempt = await request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: `aib_wrong_${index}` }),
    });
    if (attempt.status === 429) {
      rateLimited = true;
      break;
    }
  }
  assert.equal(rateLimited, true, "repeated wrong keys must be rate-limited");
  passed("连续错误访问密钥触发限速");

  const result = {
    phase: 11,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    boundaries: {
      realBrowserUi: false,
      realElectronUi: false,
      windowsNsisInstall: false,
      realAutoUpdateFeed: false,
      relay: false,
    },
    note: "真实控制平面、SQLite、静态 Web 构建、HTTP/WS 和文件流；没有执行真实浏览器/Electron 人工可用性、Windows NSIS 安装、真实更新源或远程 Relay 验收。",
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Phase 11 smoke passed ${checks.length} checks. Result: ${resultPath}`);
} finally {
  clearTimeout(watchdog);
  for (const child of children) await stopChild(child);
  if (!process.env.AGENT_IN_BOX_PHASE11_KEEP) {
    await rm(temporary, { recursive: true, force: true });
  }
}
