import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PI_ENGINE_VERSION,
  PI_SESSION_FORMAT_VERSION,
  PiWorkerEngine,
  WorkerRpcClient,
  WorkerRpcError,
  WorkerRpcServer,
  type WorkerEngineEvent,
  type WorkerSessionSpec,
} from "./index";

const fakePi = fileURLToPath(new URL("./testing/fake-pi.mjs", import.meta.url));

describe("Worker RPC", () => {
  let root: string;
  let tokenFile: string;
  let engine: PiWorkerEngine;
  let server: WorkerRpcServer;
  let client: WorkerRpcClient;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aib-worker-rpc-"));
    tokenFile = path.join(root, "worker.token");
    await writeFile(tokenFile, "rpc-token-one", { mode: 0o600 });
    engine = new PiWorkerEngine({
      sessionRoot: path.join(root, "sessions"),
      piBinary: process.execPath,
      argsPrefix: [fakePi],
      provider: "mock",
      model: "mock-cua",
      env: { ...process.env },
    });
    server = new WorkerRpcServer({ engine, tokenFile, host: "127.0.0.1", port: 0 });
    const listening = await server.start();
    baseUrl = `http://127.0.0.1:${listening.port}`;
    client = new WorkerRpcClient({
      baseUrl,
      tokenFile,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("runs the full session lifecycle and replays events after reconnect", async () => {
    await expect(client.handshake()).resolves.toMatchObject({
      compatible: true,
      engineVersion: PI_ENGINE_VERSION,
      sessionVersion: PI_SESSION_FORMAT_VERSION,
    });
    const session = await client.startSession(spec(root));
    const events: WorkerEngineEvent[] = [];
    const settled = waitForEvent((event) => {
      events.push(event);
      return event.type === "turn_finished";
    });
    const unsubscribe = client.subscribe(session.sessionId, (event) => settled.push(event));
    await client.prompt(session.sessionId, { text: "run" });
    await settled.promise;
    unsubscribe();

    const replayed: WorkerEngineEvent[] = [];
    const replayDone = waitForEvent((event) => {
      replayed.push(event);
      return event.type === "turn_finished";
    });
    const stopReplay = client.subscribe(session.sessionId, (event) => replayDone.push(event));
    await replayDone.promise;
    stopReplay();
    expect(replayed.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_started",
      "tool_finished",
      "turn_finished",
    ]);
    await expect(client.steer(session.sessionId, { text: "steer" })).resolves.toBe("queued");
    await expect(client.followUp(session.sessionId, { text: "later" })).resolves.toBe("queued");

    const archived = await client.archive(session.sessionId);
    expect(archived.summary).toBe("done");
    const manifest = JSON.parse(await readFile(`${archived.archiveRef}.manifest.json`, "utf8")) as {
      engineVersion: string;
      sessionVersion: string;
      sha256: string;
    };
    expect(manifest.engineVersion).toBe(PI_ENGINE_VERSION);
    expect(manifest.sessionVersion).toBe(PI_SESSION_FORMAT_VERSION);
    expect(manifest.sha256).toHaveLength(64);

    const resumed = await client.resume(archived.archiveRef, spec(root));
    expect(resumed.mode).toBe("native");
    expect(resumed.sessionId).toBe("resumed-session");
    await expect(client.session(resumed.sessionId)).resolves.toMatchObject({ status: "active" });
  });

  it("fails closed on token rotation and incompatible versions", async () => {
    await expect(
      client.startSession({ ...spec(root), engineVersion: "0.0.0" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "incompatible_version",
    });
    const session = await client.startSession(spec(root));
    await writeFile(tokenFile, "rpc-token-two", { mode: 0o600 });
    const stale = new WorkerRpcClient({ baseUrl, token: "rpc-token-one" });
    await expect(stale.session(session.sessionId)).rejects.toMatchObject({ status: 401 });
    const rotated = new WorkerRpcClient({
      baseUrl,
      token: "rpc-token-two",
    });
    await expect(rotated.session(session.sessionId)).resolves.toMatchObject({ status: "active" });
  });

  it("does not open an archive whose session format changed", async () => {
    const session = await client.startSession(spec(root));
    const archived = await client.archive(session.sessionId);
    const manifestPath = `${archived.archiveRef}.manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.sessionVersion = "future-format";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(client.resume(archived.archiveRef, spec(root))).rejects.toMatchObject({
      status: 409,
      code: "incompatible_version",
    });
  });

  it("rejects a non-boolean MCP setting", async () => {
    await expect(
      client.startSession({ ...spec(root), mcpEnabled: "yes" } as unknown as WorkerSessionSpec),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("rejects invalid RPC authentication without starting a process", async () => {
    const invalid = new WorkerRpcClient({
      baseUrl,
      token: "wrong-token",
    });
    await expect(invalid.startSession(spec(root))).rejects.toEqual(
      expect.objectContaining<Partial<WorkerRpcError>>({ status: 401 }),
    );
  });
});

function spec(workspacePath: string): WorkerSessionSpec {
  return {
    workerId: "worker-1",
    projectId: "project-1",
    vmId: "vm-1",
    workspacePath,
    engineType: "pi-rpc",
    engineVersion: PI_ENGINE_VERSION,
    sessionVersion: PI_SESSION_FORMAT_VERSION,
    systemPrompt: "test",
    capabilities: ["computer_use"],
  };
}

function waitForEvent(onEvent: (event: WorkerEngineEvent) => boolean): {
  promise: Promise<void>;
  push: (event: WorkerEngineEvent) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error("Timed out waiting for Worker event")), 5000);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    push(event) {
      try {
        if (onEvent(event)) resolve();
      } catch (error) {
        reject(error as Error);
      }
    },
  };
}
