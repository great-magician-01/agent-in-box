import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiWorkerEngine, type WorkerEngineEvent } from "./index";

const enabled = process.env.AIB_PI_INTEGRATION === "1";
const mockServerPath = fileURLToPath(
  new URL("../../../tests/phase0/pi/mock-model-server.mjs", import.meta.url),
);

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no free port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!enabled)("PiWorkerEngine real Pi integration", () => {
  let root: string;
  let home: string;
  let mock: ChildProcess;
  let engine: PiWorkerEngine;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aib-pi-real-"));
    home = path.join(root, "home");
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    const port = await freePort();
    await writeFile(
      path.join(home, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock",
            models: [{ id: "mock-cua", input: ["text", "image"] }],
          },
        },
      }),
    );
    mock = spawn(process.execPath, [mockServerPath], {
      env: { ...process.env, MOCK_MODEL_PORT: String(port), MOCK_MODEL_LOG: path.join(root, "mock.jsonl") },
      stdio: "ignore",
    });
    engine = new PiWorkerEngine({
      sessionRoot: path.join(root, "workers"),
      piBinary: "pi",
      env: { ...process.env, HOME: home },
      provider: "mock",
      model: "mock-cua",
    });
  });

  afterEach(async () => {
    await engine.dispose();
    mock.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  it("uses the real Pi RPC lifecycle", async () => {
    const session = await engine.startSession({
      workerId: "real-pi-worker",
      projectId: "project-1",
      vmId: "vm-1",
      workspacePath: root,
      engineType: "pi-rpc",
      systemPrompt: "Protocol integration test",
      capabilities: ["computer_use"],
    });

    const events: WorkerEngineEvent[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("real Pi did not settle")), 60000);
      const unsubscribe = engine.subscribe(session.sessionId, (event) => {
        events.push(event);
        if (event.type === "turn_finished") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    await engine.prompt(session.sessionId, { text: "plain" });
    await finished;
    expect(events.some((event) => event.type === "text_delta" && event.delta.includes("plain-ok"))).toBe(true);

    const archive = await engine.archive(session.sessionId);
    expect(archive.archiveRef).toMatch(/\.jsonl$/);
    const resumed = await engine.resume(archive.archiveRef);
    expect(resumed.mode).toBe("native");
  }, 90000);
});
