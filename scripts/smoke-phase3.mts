import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { smokeAuthHeaders } from "./smoke-auth.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-phase3-"));
const configDirectory = path.join(temporary, "config");
const children: ChildProcess[] = [];
let imageServer: Server | undefined;
let controlPlane: ChildProcess | undefined;
const startedAt = new Date().toISOString();
const checks: string[] = [];

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No free TCP port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopChild(child: ChildProcess | undefined, force = false): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  child.kill(force ? "SIGKILL" : "SIGTERM");
  let didExit = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!didExit && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    didExit = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  }
  if (!didExit && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Child process ${child.pid} did not exit`);
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}; ${lastError instanceof Error ? lastError.message : ""}`);
}

async function api<T>(port: number, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      ...smokeAuthHeaders(configDirectory),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

async function fileExists(filename: string): Promise<boolean> {
  return stat(filename).then(
    () => true,
    () => false,
  );
}

try {
  const controlPlanePort = await freePort();
  const supervisorPort = await freePort();
  const imagePort = await freePort();
  const base = Buffer.alloc(512 * 1024, 0).map((_, index) => (index * 17 + 3) % 251);
  const resume = Buffer.alloc(1024 * 1024, 0).map((_, index) => (index * 31 + 7) % 251);
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  let baseRequests = 0;
  let resumeRequests = 0;
  let observedRange = "";
  imageServer = createServer((request, response) => {
    if (request.url === "/base") {
      baseRequests++;
      response.writeHead(200, { "content-length": base.length, "content-encoding": "identity" });
      response.end(base);
      return;
    }
    if (request.url === "/resume") {
      resumeRequests++;
      if (resumeRequests === 1) {
        response.writeHead(200, { "content-length": resume.length });
        response.write(resume.subarray(0, 384 * 1024));
        // Hold the response open. The smoke test kills control-plane mid-stream.
        return;
      }
      observedRange = request.headers.range ?? "";
      const offset = Number(observedRange.match(/^bytes=(\d+)-$/)?.[1]);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= resume.length) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(206, {
        "content-length": resume.length - offset,
        "content-range": `bytes ${offset}-${resume.length - 1}/${resume.length}`,
      });
      response.end(resume.subarray(offset));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => imageServer!.listen(imagePort, "127.0.0.1", resolve));

  const manifest = {
    schemaVersion: 1,
    allowedHosts: ["127.0.0.1"],
    images: [
      {
        id: "linux-base",
        name: "Linux base",
        osFamily: "linux",
        osVersion: "24.04",
        architecture: "amd64",
        version: "smoke-1",
        url: `http://127.0.0.1:${imagePort}/base`,
        fileName: "linux-base.qcow2",
        sizeBytes: base.length,
        sha256: digest(base),
      },
      {
        id: "linux-resume",
        name: "Linux resume",
        osFamily: "linux",
        osVersion: "24.04",
        architecture: "amd64",
        version: "smoke-1",
        url: `http://127.0.0.1:${imagePort}/resume`,
        fileName: "linux-resume.qcow2",
        sizeBytes: resume.length,
        sha256: digest(resume),
      },
    ],
  };
  const manifestPath = path.join(temporary, "images.json");
  await writeFile(manifestPath, JSON.stringify(manifest));

  const supervisorBinary = path.join(
    temporary,
    `vm-supervisor${process.platform === "win32" ? ".exe" : ""}`,
  );
  await run("go", ["build", "-o", supervisorBinary, "./services/vm-supervisor/cmd/vm-supervisor"]);
  const supervisorLog = await open(path.join(temporary, "supervisor.log"), "w");
  const supervisor = spawn(
    supervisorBinary,
    [
      "-addr",
      `127.0.0.1:${supervisorPort}`,
      "-storage-root",
      path.join(temporary, "vms"),
      "-acl-token-file",
      path.join(temporary, "supervisor-acl.token"),
    ],
    { cwd: repository, stdio: ["ignore", supervisorLog.fd, supervisorLog.fd] },
  );
  children.push(supervisor);
  await supervisorLog.close();
  await waitFor(
    async () => fetch(`http://127.0.0.1:${supervisorPort}/healthz`),
    (response) => response.ok,
    "supervisor health",
  );
  passed("Supervisor starts and creates its ACL token");

  const unauthenticated = await fetch(`http://127.0.0.1:${supervisorPort}/api/v1/vms`);
  if (unauthenticated.status !== 401)
    throw new Error("Supervisor accepted an unauthenticated request");
  const token = (await readFile(path.join(temporary, "supervisor-acl.token"), "utf8")).trim();
  const authorized = await fetch(`http://127.0.0.1:${supervisorPort}/api/v1/vms`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!authorized.ok) throw new Error("Supervisor rejected its ACL token");
  passed("Supervisor ACL rejects anonymous requests and accepts the file-backed token");

  const environment = {
    ...process.env,
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    AGENT_IN_BOX_DATA_ROOT: temporary,
    CONTROL_PLANE_PORT: String(controlPlanePort),
    AGENT_IN_BOX_IMAGE_MANIFEST: manifestPath,
    AGENT_IN_BOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisorPort}`,
    AGENT_IN_BOX_GUEST_LOOPBACK_HOST: "127.0.0.1",
    AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE: path.join(temporary, "supervisor-acl.token"),
  };
  const startControlPlane = async (): Promise<void> => {
    const log = await open(path.join(temporary, `control-plane-${Date.now()}.log`), "w");
    controlPlane = spawn(process.execPath, ["services/control-plane/dist/main.js"], {
      cwd: repository,
      env: environment,
      stdio: ["ignore", log.fd, log.fd],
    });
    children.push(controlPlane);
    await log.close();
    await waitFor(
      () => api<{ status: string }>(controlPlanePort, "/api/v1/health"),
      (health) => health.status === "ok",
      "control-plane health",
    );
  };
  await startControlPlane();
  passed("Control plane opens the phase-3 migration and connects to Supervisor");

  const catalog = await api<{ items: Array<{ id: string; status: string }> }>(
    controlPlanePort,
    "/api/v1/images",
  );
  if (
    catalog.items.length !== 2 ||
    catalog.items.some((image) => image.status !== "not_downloaded")
  ) {
    throw new Error(`Unexpected initial catalog: ${JSON.stringify(catalog)}`);
  }
  const events = await fetch(`http://127.0.0.1:${controlPlanePort}/api/v1/images/events`, {
    headers: smokeAuthHeaders(configDirectory),
  });
  const eventReader = events.body?.getReader();
  if (!eventReader) throw new Error("SSE response has no body");
  console.log("STAGE: downloading base image");
  const downloaded = await api<{ status: string; localPath: string }>(
    controlPlanePort,
    "/api/v1/images/linux-base/download",
    { method: "POST" },
  );
  if (downloaded.status !== "available") throw new Error("Image did not become available");
  console.log("STAGE: base image request completed; reading SSE events");
  let eventText = "";
  const eventDeadline = Date.now() + 5000;
  const decoder = new TextDecoder();
  while (!eventText.includes("imageId") && Date.now() < eventDeadline) {
    const event = await Promise.race([
      eventReader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE read timed out")), 5000),
      ),
    ]);
    if (event.done) break;
    eventText += decoder.decode(event.value, { stream: true });
  }
  if (!eventText.includes("imageId")) throw new Error(`Malformed SSE event: ${eventText}`);
  await eventReader.cancel();
  await api(controlPlanePort, "/api/v1/images/linux-base/download", { method: "POST" });
  if (baseRequests !== 1) throw new Error(`Same image was downloaded ${baseRequests} times`);
  const activated = await readFile(downloaded.localPath);
  if (digest(activated) !== digest(base)) throw new Error("Activated image hash mismatch");
  passed("Manifest download, SHA-256 activation, SSE progress and same-image dedupe pass");

  const vmList = await api<{ items: unknown[]; supervisor: { available: boolean } }>(
    controlPlanePort,
    "/api/v1/vms",
  );
  if (!vmList.supervisor.available || vmList.items.length !== 0)
    throw new Error("Control plane did not reach Supervisor VM API");
  passed("Control plane reaches the authenticated VM lifecycle surface");

  const pendingDownload = api(controlPlanePort, "/api/v1/images/linux-resume/download", {
    method: "POST",
  }).catch(() => undefined);
  const partial = path.join(temporary, "images", "linux-resume.qcow2.partial");
  await waitFor(
    async () => ((await fileExists(partial)) ? (await stat(partial)).size : 0),
    (size) => size > 0,
    "partial download",
  );
  console.log("STAGE: stopping control plane during active download");
  await stopChild(controlPlane, true);
  console.log("STAGE: control plane stopped; awaiting interrupted request");
  await pendingDownload;
  console.log("STAGE: interrupted request settled");
  const retainedBytes = (await stat(partial)).size;
  if (retainedBytes <= 0 || retainedBytes >= resume.length)
    throw new Error("Invalid retained partial size");

  await startControlPlane();
  await waitFor(
    () => api<{ status: string }>(controlPlanePort, "/api/v1/images/linux-resume"),
    (image) => image.status === "available",
    "automatic resume after control-plane restart",
  );
  if (observedRange !== `bytes=${retainedBytes}-`)
    throw new Error(`Unexpected resume Range: ${observedRange}; partial ${retainedBytes}`);
  if (
    digest(await readFile(path.join(temporary, "images", "linux-resume.qcow2"))) !== digest(resume)
  )
    throw new Error("Resumed image hash mismatch");
  passed(
    "A killed control plane resumes persisted partial bytes after restart and verifies the result",
  );

  const result = {
    taskId: "PHASE3-SMOKE-001",
    status: "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    checks,
    realQemuValidated: false,
    notes:
      "Local HTTP artifacts and real control-plane/Supervisor processes. No QEMU/WHPX claim; run the explicitly gated provider integration test on a host with the phase-0 assets.",
  };
  const resultPath = process.env.AGENT_IN_BOX_PHASE3_RESULT ?? path.join(temporary, "result.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Phase 3 smoke result: ${resultPath}`);
} finally {
  await stopChild(controlPlane, true);
  for (const child of children.reverse()) await stopChild(child, true);
  if (imageServer) {
    imageServer.closeAllConnections();
    await new Promise<void>((resolve) => imageServer!.close(() => resolve()));
  }
  if (!process.env.AGENT_IN_BOX_PHASE3_KEEP) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else {
    console.log(`Retained smoke directory: ${temporary}`);
  }
}
