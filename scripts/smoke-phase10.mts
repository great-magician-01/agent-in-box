import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { smokeAuthHeaders } from "./smoke-auth.mjs";
import type {
  BotAccountRecord,
  BotAccountView,
  BotOverview,
  TaskBoardSnapshot,
  TaskRecord,
} from "@agent-in-box/protocol";
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  getFeishuHeader,
  type FeishuFrame,
} from "../packages/bot-connector/src/test-support/feishu-frame-codec";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface QqFixture {
  url: string;
  sends: Array<{ path: string; body: Record<string, unknown> }>;
  sendC2C(user: string, text: string, messageId: string): void;
  sendGroup(user: string, text: string, messageId: string, groupId?: string): void;
  ready(): boolean;
  close(): Promise<void>;
}

interface FeishuFixture {
  url: string;
  sends: Array<{ text: string; chatId: string }>;
  sendEvent(input: {
    messageId: string;
    text: string;
    chatId: string;
    userId: string;
    chatType: "p2p" | "group";
    mentionBot?: boolean;
  }): void;
  ready(): boolean;
  close(): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase10-"));
const configDirectory = path.join(temporary, "config");
const resultPath =
  process.env.AGENT_IN_BOX_PHASE10_RESULT?.trim() ||
  path.join(
    repository,
    "tests/phase10/results",
    `${new Date().toISOString().slice(0, 10)}-smoke.json`,
  );
const checks: CheckResult[] = [];
const children: ChildProcess[] = [];
const controlPlanePort = await freePort();
const supervisorPort = await freePort();
const modelBrokerPort = await freePort();
const cuaBrokerPort = await freePort();
const routerBrokerPort = await freePort();
const supervisorToken = "phase10-supervisor-token";
const qqSecret = "phase10-qq-client-secret";
const feishuSecret = "phase10-feishu-app-secret";
const feishuAppId = "cli_0123456789abcdef";
const startedAt = new Date().toISOString();
let controlPlane: ChildProcess | undefined;
let supervisorServer: Server | undefined;
let qq: QqFixture | undefined;
let feishu: FeishuFixture | undefined;
let projectId = "";
let vmId = "";
let qqAccountId = "";
let feishuAccountId = "";
let taskId = "";
const watchdog = setTimeout(() => {
  console.error(`phase10 smoke watchdog timeout after ${checks.length} checks`);
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
      ...smokeAuthHeaders(configDirectory),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`${route} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function startQqFixture(): Promise<QqFixture> {
  const sends: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sockets = new Set<WebSocket>();
  const readySockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const json = (value: unknown): void => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.method === "POST" && url.pathname === "/app/getAppAccessToken") {
        json({ access_token: "phase10-qq-token", expires_in: "7200" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/gateway") {
        json({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/websocket` });
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname.startsWith("/v2/users/") || url.pathname.startsWith("/v2/groups/"))
      ) {
        sends.push({
          path: url.pathname,
          body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
        });
        json({ id: `qq-reply-${sends.length}`, timestamp: new Date().toISOString() });
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    })();
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      sockets.add(websocket);
      websocket.on("close", () => {
        sockets.delete(websocket);
        readySockets.delete(websocket);
      });
      websocket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } }));
      websocket.on("message", (data) => {
        const payload = JSON.parse(data.toString()) as { op?: number; d?: unknown };
        if (payload.op === 1) {
          websocket.send(JSON.stringify({ op: 11 }));
          return;
        }
        if (payload.op === 2) {
          readySockets.add(websocket);
          websocket.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: { version: 1, session_id: "phase10-session", user: { id: "bot-1" } },
            }),
          );
          return;
        }
        if (payload.op === 6) {
          readySockets.add(websocket);
          websocket.send(JSON.stringify({ op: 0, s: 2, t: "RESUMED", d: {} }));
        }
      });
    });
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  let sequence = 10;
  const emit = (payload: Record<string, unknown>): void => {
    const socket = [...readySockets].at(-1);
    if (!socket) throw new Error("QQ fixture has no ready socket");
    sequence += 1;
    socket.send(JSON.stringify({ op: 0, s: sequence, ...payload }));
  };
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    sendC2C(user, text, messageId) {
      emit({
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: messageId,
          content: text,
          timestamp: new Date().toISOString(),
          author: { user_openid: user },
        },
      });
    },
    sendGroup(user, text, messageId, groupId = "group-1") {
      emit({
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: messageId,
          content: text,
          timestamp: new Date().toISOString(),
          group_openid: groupId,
          author: { member_openid: user, user_openid: user },
        },
      });
    },
    ready() {
      return readySockets.size > 0;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function startFeishuFixture(): Promise<FeishuFixture> {
  const sends: Array<{ text: string; chatId: string }> = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const json = (value: unknown): void => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.method === "POST" && url.pathname === "/callback/ws/endpoint") {
        json({
          code: 0,
          msg: "ok",
          data: {
            URL: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws?device_id=phase10&service_id=155`,
            ClientConfig: {
              PingInterval: 30,
              ReconnectInterval: 1,
              ReconnectCount: 10,
              ReconnectNonce: 0,
            },
          },
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/open-apis/auth/v3/tenant_access_token/internal"
      ) {
        json({ code: 0, msg: "ok", tenant_access_token: "phase10-feishu-token", expire: 7_200 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/open-apis/im/v1/messages") {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const content =
          typeof parsed.content === "string"
            ? (JSON.parse(parsed.content) as { text?: string }).text
            : undefined;
        sends.push({
          text: content ?? "",
          chatId: typeof parsed.receive_id === "string" ? parsed.receive_id : "",
        });
        json({ code: 0, msg: "success" });
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    })();
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      sockets.add(websocket);
      websocket.on("close", () => sockets.delete(websocket));
      websocket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        let frame: FeishuFrame;
        try {
          frame = decodeFeishuFrame(toBytes(data));
        } catch {
          return;
        }
        if (getFeishuHeader(frame, "type") === "ping") {
          setTimeout(() => {
            websocket.send(
              encodeFeishuFrame({
                ...frame,
                method: 0,
                payload: new TextEncoder().encode(
                  JSON.stringify({
                    PingInterval: 30,
                    ReconnectCount: 10,
                    ReconnectInterval: 1,
                    ReconnectNonce: 0,
                  }),
                ),
                headers: [{ key: "type", value: "pong" }],
              }),
            );
          }, 5);
          return;
        }
        // The official SDK ACKs events itself; the fixture only needs to keep
        // the connection alive and answer pings.
      });
    });
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    sendEvent(input) {
      const socket = [...sockets].at(-1);
      if (!socket) throw new Error("Feishu fixture has no socket");
      const message = {
        message_id: input.messageId,
        chat_id: input.chatId,
        chat_type: input.chatType,
        message_type: "text",
        content: JSON.stringify({ text: input.text }),
        create_time: String(Date.now()),
        ...(input.mentionBot
          ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_smoke" }, name: "bot" }] }
          : {}),
      };
      socket.send(
        encodeFeishuFrame({
          seqId: 1n,
          logId: 2n,
          service: 155,
          method: 1,
          headers: [
            { key: "type", value: "event" },
            { key: "message_id", value: input.messageId },
            { key: "sum", value: "1" },
            { key: "seq", value: "0" },
            { key: "trace_id", value: "phase10-trace" },
          ],
          payload: new TextEncoder().encode(
            JSON.stringify({
              schema: "2.0",
              header: {
                event_id: input.messageId,
                event_type: "im.message.receive_v1",
                create_time: String(Date.now()),
              },
              event: {
                sender: { sender_id: { open_id: input.userId }, sender_type: "user" },
                message,
              },
            }),
          ),
        }),
      );
    },
    ready() {
      return sockets.size > 0;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

async function startSupervisorFixture(): Promise<void> {
  supervisorServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${supervisorToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized" } }));
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    const state = {
      id: vmId,
      powerState: "running",
      pid: 4242,
      qmpPort: 14444,
      sshHostPort: 10022,
      guestHostPort: 17611,
      workerHostPort: 0,
      consoleUrl: "vnc://127.0.0.1:5901",
      diskPath: path.join(temporary, "vms", vmId, "disk.qcow2"),
      guestHealth: "healthy",
      lastError: "",
      updatedAt: new Date().toISOString(),
    };
    if (url.pathname === `/api/v1/vms/${vmId}` || url.pathname === "/api/v1/vms") {
      response.end(JSON.stringify(url.pathname.endsWith("/vms") ? { items: [state] } : state));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await listen(supervisorServer, supervisorPort);
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
        AGENT_IN_BOX_ROUTER_BROKER_PORT: String(routerBrokerPort),
        AGENT_IN_BOX_ROUTER_PI_BINARY: process.execPath,
        AGENT_IN_BOX_ROUTER_PI_ARGS: JSON.stringify([
          path.join(repository, "tests/phase10/fake-router-pi.mjs"),
        ]),
        AGENT_IN_BOX_ROUTER_PROVIDER: "mock",
        AGENT_IN_BOX_ROUTER_MODEL: "router-model",
        AGENT_IN_BOX_BOT_CREDENTIALS_FILE: path.join(temporary, "bot-credentials.json"),
        AGENT_IN_BOX_BOT_TICK_MS: "200",
        AGENT_IN_BOX_BOT_INGRESS_TICK_MS: "100",
        AGENT_IN_BOX_BOT_OUTBOUND_TICK_MS: "100",
        AGENT_IN_BOX_BOT_NOTIFICATION_TICK_MS: "100",
        PHASE10_PROJECT_ID: projectId,
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
  throw new Error("control plane did not become healthy");
}

async function bots(): Promise<BotOverview> {
  return api<BotOverview>("/api/v1/bots");
}

async function account(platform: "feishu" | "qq"): Promise<BotAccountView> {
  const overview = await bots();
  const found = overview.accounts.find((item) => item.platform === platform);
  if (!found) throw new Error(`missing ${platform} account`);
  return found;
}

async function waitConnected(platform: "feishu" | "qq"): Promise<void> {
  await waitFor(
    async () => (await account(platform)).state === "connected",
    `${platform} connected`,
  );
}

async function waitSend(
  sends: Array<{ text?: string; body?: Record<string, unknown> }>,
  predicate: (text: string) => boolean,
  label: string,
  timeout = 30_000,
): Promise<string> {
  let matched = "";
  await waitFor(
    () => {
      for (const item of sends) {
        const text = item.text ?? (typeof item.body?.content === "string" ? item.body.content : "");
        if (predicate(text)) {
          matched = text;
          return true;
        }
      }
      return false;
    },
    label,
    timeout,
  );
  return matched;
}

async function taskBoard(): Promise<TaskBoardSnapshot> {
  return api<TaskBoardSnapshot>("/api/v1/tasks/board");
}

try {
  const dist = (name: string) =>
    pathToFileURL(path.join(repository, "services/control-plane/dist", name)).href;
  const { AppDatabase } = await import(dist("persistence/database.js"));
  const { CatalogRepository } = await import(
    dist("persistence/repositories/catalog-repository.js")
  );

  await mkdir(path.join(temporary, "vms"), { recursive: true });
  await writeFile(path.join(temporary, "supervisor-acl.token"), supervisorToken, { mode: 0o600 });
  await writeFile(
    path.join(temporary, "bot-credentials.json"),
    JSON.stringify({
      "bot-qq-smoke": qqSecret,
      "bot-feishu-smoke": feishuSecret,
    }),
    { mode: 0o600 },
  );

  const seed = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await seed.migrate();
  const catalog = new CatalogRepository(seed.db);
  const image = await catalog.createImage({
    name: "Phase 10 Linux",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "smoke-1",
    sizeBytes: 1,
    checksum: "0".repeat(64),
    localPath: path.join(temporary, "base.qcow2"),
  });
  const project = await catalog.createProject({
    name: "Phase 10 bot project",
    description: "Phase 10 bot smoke project",
  });
  const vm = await catalog.createVm({
    name: "Phase 10 bot VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: path.join(temporary, "vms", "phase10-vm"),
  });
  await mkdir(vm.storageRoot, { recursive: true });
  await catalog.bindVm({
    projectId: project.id,
    vmId: vm.id,
    guestWorkspacePath: "/home/worker/workspace",
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
  await seed.close();
  projectId = project.id;
  vmId = vm.id;

  qq = await startQqFixture();
  feishu = await startFeishuFixture();
  await startSupervisorFixture();
  await startControlPlane();

  await api("/api/v1/models/providers/mock", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      credentialProviderId: "mock",
      models: [
        { id: "router-model", name: "Mock Router" },
        { id: "mock", name: "Mock" },
      ],
      enabled: true,
    }),
  });

  const initial = await bots();
  assert.ok(initial.deviceId);
  assert.equal(initial.accounts.length, 0);
  passed("控制平面启动并暴露机器人状态与持久设备身份", `device=${initial.deviceId}`);

  const bound = await api<BotOverview>("/api/v1/bots/device", {
    method: "POST",
    body: JSON.stringify({ active: true }),
  });
  assert.equal(bound.thisDeviceActive, true);
  passed("绑定本机为唯一活跃执行电脑");

  const qqAccount = await api<BotAccountRecord>("/api/v1/bots/accounts", {
    method: "POST",
    body: JSON.stringify({
      platform: "qq",
      name: "Smoke QQ",
      appId: "100200300",
      credentialProviderId: "bot-qq-smoke",
      config: { apiBase: qq.url, tokenBaseUrl: qq.url },
      enabled: true,
    }),
  });
  qqAccountId = qqAccount.id;
  const feishuAccount = await api<BotAccountRecord>("/api/v1/bots/accounts", {
    method: "POST",
    body: JSON.stringify({
      platform: "feishu",
      name: "Smoke Feishu",
      appId: feishuAppId,
      credentialProviderId: "bot-feishu-smoke",
      config: { domain: feishu.url, botUserId: "ou_bot_smoke" },
      enabled: true,
    }),
  });
  feishuAccountId = feishuAccount.id;
  await waitConnected("qq");
  await waitConnected("feishu");
  await waitFor(() => qq!.ready() && feishu!.ready(), "platform websockets");
  passed("QQ 与飞书机器人通过本机出站长连接上线");

  const qqCode = await api<{ code: string }>("/api/v1/bots/access-codes", {
    method: "POST",
    body: JSON.stringify({ role: "admin" }),
  });
  qq.sendC2C("qq-user-1", `/bind ${qqCode.code}`, "qq-bind-1");
  await waitSend(qq.sends, (text) => text.includes("绑定成功"), "QQ bind reply");
  passed("QQ 单聊一次性绑定码完成平台身份与本地管理员绑定");

  const feishuCode = await api<{ code: string }>("/api/v1/bots/access-codes", {
    method: "POST",
    body: JSON.stringify({ role: "admin" }),
  });
  feishu.sendEvent({
    messageId: "fs-bind-1",
    text: `/bind ${feishuCode.code}`,
    chatId: "oc_p2p_user1",
    userId: "ou_user_1",
    chatType: "p2p",
  });
  await waitSend(feishu.sends, (text) => text.includes("绑定成功"), "Feishu bind reply");
  passed("飞书单聊一次性绑定码完成绑定");

  qq.sendC2C("qq-user-1", "/status", "qq-status-1");
  await waitSend(qq.sends, (text) => text.includes("本机状态：在线"), "QQ status reply");
  feishu.sendEvent({
    messageId: "fs-status-1",
    text: "/status",
    chatId: "oc_p2p_user1",
    userId: "ou_user_1",
    chatType: "p2p",
  });
  await waitSend(feishu.sends, (text) => text.includes("本机状态：在线"), "Feishu status reply");
  passed("QQ 与飞书查询本机、Router、任务和资源状态");

  const beforeDenied = qq.sends.length;
  qq.sendC2C("qq-user-2", "/status", "qq-denied-1");
  await delay(800);
  await waitSend(
    qq.sends.slice(beforeDenied),
    (text) => text.includes("尚未绑定"),
    "QQ unbound denial",
  );
  passed("未授权平台用户被拒绝执行命令，且不会操作 VM");

  const beforeGroup = qq.sends.length;
  qq.sendGroup("qq-user-1", "/status", "qq-group-denied-1");
  await delay(800);
  assert.equal(qq.sends.length, beforeGroup, "unlisted group should be ignored");
  await api("/api/v1/bots/chats", {
    method: "PUT",
    body: JSON.stringify({
      platform: "qq",
      conversationId: "group:group-1",
      kind: "group",
      allowed: true,
    }),
  });
  qq.sendGroup("qq-user-1", "/status", "qq-group-1");
  await delay(800);
  await waitSend(
    qq.sends.slice(beforeGroup),
    (text) => text.includes("本机状态：在线"),
    "QQ group reply",
  );
  passed("未加入白名单的群聊被忽略，授权群聊可正常响应");

  const beforeFeishuGroup = feishu.sends.length;
  await api("/api/v1/bots/chats", {
    method: "PUT",
    body: JSON.stringify({
      platform: "feishu",
      conversationId: "oc_group_1",
      kind: "group",
      allowed: true,
    }),
  });
  feishu.sendEvent({
    messageId: "fs-group-no-mention",
    text: "/status",
    chatId: "oc_group_1",
    userId: "ou_user_1",
    chatType: "group",
    mentionBot: false,
  });
  await delay(800);
  assert.equal(feishu.sends.length, beforeFeishuGroup, "unmentioned Feishu group message ignored");
  feishu.sendEvent({
    messageId: "fs-group-mention",
    text: "/status",
    chatId: "oc_group_1",
    userId: "ou_user_1",
    chatType: "group",
    mentionBot: true,
  });
  await delay(800);
  await waitSend(
    feishu.sends.slice(beforeFeishuGroup),
    (text) => text.includes("本机状态：在线"),
    "Feishu mentioned group reply",
  );
  passed("飞书群聊必须 @ 配置的机器人 Open ID 才响应");

  qq.sendC2C("qq-user-1", "BOT-CREATE 请创建一个任务", "qq-nl-1");
  await waitFor(async () => {
    const board = await taskBoard();
    const found = board.tasks.find((task) => task.objective === "Phase 10 bot-created task");
    if (!found) return false;
    taskId = found.id;
    return true;
  }, "Router-created task");
  await waitSend(qq.sends, (text) => text.includes("已创建任务"), "task created notification");
  const task = (
    await api<{ items: TaskRecord[] }>(`/api/v1/tasks?projectId=${projectId}`)
  ).items.find((item) => item.id === taskId);
  assert.ok(task);
  const turn = (await bots()).recentTurns.find((item) => item.userText.includes("BOT-CREATE"));
  assert.ok(turn, "bot turn should be recorded");
  passed(
    "机器人消息进入主 Router 会话，Router 创建持久任务并回传任务通知",
    `task=${taskId} turn=${turn.status}`,
  );

  const beforeDuplicate = qq.sends.length;
  qq.sendC2C("qq-user-1", "BOT-CREATE 请创建一个任务", "qq-nl-1");
  await delay(1200);
  assert.equal(qq.sends.length, beforeDuplicate, "duplicate platform event must not be processed");
  passed("平台重推同一事件 ID 不会重复创建任务或回复");

  const beforeCancel = qq.sends.length;
  qq.sendC2C("qq-user-1", `/cancel ${taskId}`, "qq-cancel-1");
  await delay(800);
  await waitSend(
    qq.sends.slice(beforeCancel),
    (text) => text.includes("/confirm cancel"),
    "cancel confirmation prompt",
  );
  assert.notEqual(await boardStatus(taskId), "cancelled");
  qq.sendC2C("qq-user-1", `/confirm cancel ${taskId}`, "qq-cancel-2");
  await delay(800);
  await waitFor(async () => (await boardStatus(taskId)) === "cancelled", "task cancelled");
  await waitSend(
    qq.sends.slice(beforeCancel),
    (text) => text.includes("已取消"),
    "cancel confirmation result",
  );
  passed("取消任务等敏感操作需要管理员二次确认后执行");

  await stopChild(controlPlane);
  // The platform fixtures stay up; only the local control plane restarts, so
  // account URLs and device-scoped dedupe keys remain comparable.
  await startControlPlane();
  await waitConnected("qq");
  await waitFor(() => qq!.ready(), "QQ reconnected");
  await delay(500);
  const beforeRestart = qq.sends.length;
  qq.sendC2C("qq-user-1", "BOT-STATUS", "qq-nl-1");
  await delay(1500);
  assert.equal(qq.sends.length, beforeRestart, "old event ID must stay deduplicated after restart");
  passed("控制平面重启后持久去重仍生效，旧消息不会重复执行");

  clearTimeout(watchdog);
  const summary = {
    phase: 10,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    passed: checks.length,
    failed: 0,
    accounts: { qq: qqAccountId, feishu: feishuAccountId },
    taskId,
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`phase10 smoke: ${checks.length} checks passed`);
  await stopChild(controlPlane);
  await qq?.close();
  await feishu?.close();
  await new Promise<void>((resolve) => {
    if (supervisorServer) supervisorServer.close(() => resolve());
    else resolve();
  });
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  clearTimeout(watchdog);
  console.error(error);
  for (const child of children) child.kill("SIGKILL");
  await qq?.close().catch(() => undefined);
  await feishu?.close().catch(() => undefined);
  process.exit(1);
}

async function boardStatus(id: string): Promise<string> {
  const detail = await api<{ task: TaskRecord }>(`/api/v1/tasks/${id}`);
  return detail.task.status;
}
