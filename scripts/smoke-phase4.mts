import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase4-"));
const children: ChildProcess[] = [];
const servers: Server[] = [];
const tcpServers: net.Server[] = [];
const tcpSockets = new Set<Socket>();
const checks: string[] = [];
const startedAt = new Date().toISOString();
const vmId = "phase4-smoke-vm";

function passed(message: string): void {
  checks.push(message);
  console.log(`PASS: ${message}`);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let done = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    done = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
  }
  if (!done) throw new Error(`Child ${child.pid} did not exit`);
}

async function api<T>(port: number, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
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

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Control plane did not become healthy");
}

function rfbHandshake(): Buffer {
  const name = Buffer.from("phase4");
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  init.writeUInt32BE(name.length, 20);
  return Buffer.concat([
    Buffer.from("RFB 003.008\n"),
    Buffer.from([1, 1]),
    Buffer.alloc(4),
    init,
    name,
  ]);
}

try {
  const controlPlanePort = await freePort();
  const guestPort = await freePort();
  const guestToken = randomBytes(32).toString("base64url");
  const supervisorToken = randomBytes(32).toString("base64url");
  const supervisorTokenFile = path.join(temporary, "supervisor-acl.token");
  const guestTokenFile = path.join(temporary, "vms", vmId, "guest-agent.token");
  await mkdir(path.dirname(guestTokenFile), { recursive: true });
  await writeFile(supervisorTokenFile, supervisorToken, { mode: 0o600 });
  await writeFile(guestTokenFile, guestToken, { mode: 0o600 });

  let vncInput = Buffer.alloc(0);
  const serverRfbHandshake = rfbHandshake();
  const vncServer = net.createServer((socket) => {
    tcpSockets.add(socket);
    socket.on("close", () => tcpSockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write(serverRfbHandshake);
    socket.on("data", (chunk) => {
      vncInput = Buffer.concat([vncInput, chunk]);
    });
  });
  vncServer.listen(0, "127.0.0.1");
  await once(vncServer, "listening");
  tcpServers.push(vncServer);
  const vncPort = (vncServer.address() as AddressInfo).port;

  const runtime = {
    id: vmId,
    powerState: "running",
    pid: 1234,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: guestPort,
    consoleUrl: `vnc://127.0.0.1:${vncPort}`,
    diskPath: path.join(temporary, "vms", vmId, "disk.qcow2"),
    guestHealth: "healthy",
    lastError: "",
    updatedAt: new Date().toISOString(),
  };
  const supervisor = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${supervisorToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid token" } }));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/vms") response.end(JSON.stringify({ items: [runtime] }));
    else if (request.url === `/api/v1/vms/${vmId}`) response.end(JSON.stringify(runtime));
    else if (request.url === `/api/v1/vms/${vmId}/console`)
      response.end(JSON.stringify({ consoleUrl: runtime.consoleUrl }));
    else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
    }
  });
  const supervisorPort = await listen(supervisor);

  const updateBytes = Buffer.from("verified phase-4 guest-agent test payload");
  const updateServer = createServer((request, response) => {
    if (request.url === "/guest-agent.bin" && !request.headers.authorization) {
      response.writeHead(200, { "content-length": updateBytes.length });
      response.end(updateBytes);
    } else response.writeHead(404).end();
  });
  const updatePort = await listen(updateServer);

  const { AppDatabase } = await import(
    pathToFileURL(path.join(repository, "services/control-plane/dist/persistence/database.js")).href
  );
  const database = AppDatabase.open({ filename: path.join(temporary, "agent-in-box.sqlite") });
  await database.migrate();
  const now = new Date().toISOString();
  await database.db
    .insertInto("images")
    .values({
      id: "phase4-image",
      name: "Phase 4 test",
      os_family: "linux",
      os_version: "24.04",
      architecture: "amd64",
      version: "test",
      status: "available",
      size_bytes: 1,
      checksum: "0".repeat(64),
      local_path: path.join(temporary, "base.qcow2"),
      created_at: now,
      verified_at: now,
      source_url: "http://127.0.0.1/test",
      file_name: "base.qcow2",
      downloaded_bytes: 1,
      error_code: null,
      error_message: null,
      updated_at: now,
      seed_local_path: null,
      manifest_json: "",
    })
    .execute();
  await database.db
    .insertInto("vm_instances")
    .values({
      id: vmId,
      name: "Phase 4 Smoke VM",
      image_id: "phase4-image",
      os_family: "linux",
      cpu_count: 2,
      memory_bytes: 2 * 1024 ** 3,
      disk_bytes: 20 * 1024 ** 3,
      storage_root: path.join(temporary, "vms", vmId),
      power_state: "running",
      guest_health: "healthy",
      created_at: now,
      last_started_at: now,
    })
    .execute();
  await database.close();

  const guestBinary = path.join(
    temporary,
    process.platform === "win32" ? "guest-agent.exe" : "guest-agent",
  );
  await run("go", ["build", "-o", guestBinary, "./services/guest-agent/cmd/guest-agent"]);
  const guest = spawn(
    guestBinary,
    [
      "-addr",
      `127.0.0.1:${guestPort}`,
      "-token-file",
      guestTokenFile,
      "-update-dir",
      path.join(temporary, "updates"),
    ],
    { cwd: repository, stdio: ["ignore", "inherit", "inherit"] },
  );
  children.push(guest);

  const control = spawn(
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
        AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: supervisorTokenFile,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  children.push(control);
  await waitForHealth(controlPlanePort);
  passed("真实控制平面启动，Guest/Supervisor ACL 文件均从 VM 数据目录解析");

  const unauthenticated = await fetch(`http://127.0.0.1:${guestPort}/v1/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "wait", milliseconds: 1 }),
  });
  if (unauthenticated.status !== 401)
    throw new Error(`Unauthenticated guest input returned ${unauthenticated.status}`);
  passed("真实 Guest Agent 拒绝未认证输入");

  const heartbeat = await api<{ status: string; compatible: boolean }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/guest/heartbeat?protocolVersion=0.1.0`,
  );
  if (!heartbeat.compatible || !["ok", "degraded"].includes(heartbeat.status))
    throw new Error("Invalid guest heartbeat");
  const capabilities = await api<{ agentVersion: string; protocolVersion: string }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/guest/capabilities`,
  );
  if (!capabilities.agentVersion || capabilities.protocolVersion !== "0.1.0")
    throw new Error("Invalid guest version handshake");
  const version = await api<{ compatible: boolean; minimumProtocolVersion: string }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/guest/version`,
  );
  if (!version.compatible || version.minimumProtocolVersion !== "0.1.0")
    throw new Error("Incompatible guest protocol handshake");
  passed("控制平面认证管理通道、心跳、能力和版本信息可用");

  const update = await api<{ ok: boolean; restartRequired: boolean; stagedPath: string }>(
    guestPort,
    "/v1/update",
    {
      method: "POST",
      headers: { authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({
        actionId: "smoke-update-1",
        version: "0.1.1",
        url: `http://127.0.0.1:${updatePort}/guest-agent.bin`,
        sizeBytes: updateBytes.length,
        sha256: createHash("sha256").update(updateBytes).digest("hex"),
        protocolVersion: "0.1.0",
        os: process.platform === "win32" ? "windows" : "linux",
        architecture: process.arch === "x64" ? "amd64" : "arm64",
      }),
    },
  );
  if (
    !update.ok ||
    !update.restartRequired ||
    !(await readFile(update.stagedPath)).equals(updateBytes)
  )
    throw new Error("Verified update was not staged");
  passed("Guest Agent 更新经过大小/SHA-256 校验后暂存，更新源未收到 Bearer 令牌");

  const worker = await api<{ id: string }>(controlPlanePort, `/api/v1/vms/${vmId}/lease/worker`, {
    method: "POST",
    body: JSON.stringify({ taskId: "phase4-smoke-task" }),
  });
  const session = await api<{ webSocketUrl: string; lease: { id: string } }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/console/sessions`,
    { method: "POST", body: "{}" },
  );
  const controlState = await api<{ state: string }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/control`,
  );
  if (controlState.state !== "human") throw new Error("Human takeover did not replace AI control");
  const oldAction = await fetch(
    `http://127.0.0.1:${controlPlanePort}/api/v1/vms/${vmId}/guest/actions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: worker.id, action: { type: "wait", milliseconds: 1 } }),
    },
  );
  if (oldAction.status !== 409) throw new Error(`Old AI action returned ${oldAction.status}`);
  passed("人工接管撤销 AI Lease，旧 AI 动作被拒绝且未发送给 Guest");

  const { WebSocket } = await import(
    pathToFileURL(path.join(repository, "services/control-plane/node_modules/ws/wrapper.mjs")).href
  );
  console.log("Phase 4 smoke: opening VNC WebSocket");
  const socket = new WebSocket(`ws://127.0.0.1:${controlPlanePort}${session.webSocketUrl}`);
  let serverHandshake = Buffer.alloc(0);
  socket.on("message", (data: Buffer) => {
    serverHandshake = Buffer.concat([serverHandshake, data]);
  });
  await Promise.race([
    once(socket, "open"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("VNC WebSocket open timed out")), 5000),
    ),
  ]);
  console.log("Phase 4 smoke: VNC WebSocket open");
  const handshakeDeadline = Date.now() + 5000;
  while (serverHandshake.length < serverRfbHandshake.length && Date.now() < handshakeDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (serverHandshake.length < serverRfbHandshake.length)
    throw new Error("VNC handshake timed out");
  console.log("Phase 4 smoke: VNC handshake received");
  const closed = once(socket, "close");
  const pointer = Buffer.from([5, 1, 0, 100, 0, 200]);
  socket.send(pointer, { binary: true });
  const deadline = Date.now() + 3000;
  while (!vncInput.equals(pointer) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!vncInput.equals(pointer))
    throw new Error("Leased VNC pointer input did not reach RFB server");
  const extendedKey = Buffer.from([255, 0, 1, 0, 0, 0, 0, 65, 0, 0, 0, 65]);
  const expectedInput = Buffer.concat([pointer, extendedKey]);
  socket.send(extendedKey, { binary: true });
  while (!vncInput.equals(expectedInput) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!vncInput.equals(expectedInput))
    throw new Error("Leased QEMU extended keyboard input did not reach RFB server");
  console.log("Phase 4 smoke: leased pointer and QEMU extended key reached RFB peer");
  const released = await api<{ released: boolean }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/lease/release`,
    { method: "POST", body: JSON.stringify({ leaseId: session.lease.id }) },
  );
  if (!released.released) throw new Error("Control plane did not release the console Lease");
  const afterRelease = await api<{ state: string }>(
    controlPlanePort,
    `/api/v1/vms/${vmId}/control`,
  );
  if (afterRelease.state !== "idle")
    throw new Error(`Lease release left control state ${afterRelease.state}`);
  console.log(`Phase 4 smoke: human Lease released (socket state ${socket.readyState})`);
  socket.send(extendedKey, { binary: true });
  const [closeCode] = await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("VNC Lease revocation close timed out")), 5000),
    ),
  ]);
  if (closeCode !== 1008 || !vncInput.equals(expectedInput))
    throw new Error("Input after Lease release was not blocked");
  passed("noVNC WebSocket 代理逐帧校验人工 Lease，释放后输入立即失败关闭");

  const result = {
    phase: 4,
    startedAt,
    completedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    checks,
    realQemuValidated: false,
    realDesktopInputValidated: false,
    note: "Real control-plane and guest-agent processes with a synthetic RFB/update peer; not a QEMU/WHPX or X11 acceptance run.",
  };
  const resultPath =
    process.env.AGENT_IN_BOX_PHASE4_RESULT ??
    path.join(repository, "tests/phase4/results/2026-11-11-smoke.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Phase 4 smoke result: ${resultPath}`);
} finally {
  console.log("Phase 4 smoke: cleaning up child processes");
  await Promise.allSettled(children.reverse().map((child) => stopChild(child)));
  console.log("Phase 4 smoke: closing HTTP peers");
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("Phase 4 smoke: closing RFB peer");
  for (const socket of tcpSockets) socket.destroy();
  for (const server of tcpServers)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
  console.log("Phase 4 smoke: cleanup complete");
}
