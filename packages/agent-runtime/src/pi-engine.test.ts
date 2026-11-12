import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiWorkerEngine, type WorkerEngineEvent } from "./index";

const fakePi = fileURLToPath(new URL("./testing/fake-pi.mjs", import.meta.url));

describe("PiWorkerEngine", () => {
  let root: string;
  let engine: PiWorkerEngine;
  let argsLog: string;
  let envLog: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aib-pi-engine-"));
    argsLog = path.join(root, "pi-args.json");
    envLog = path.join(root, "pi-env.json");
    engine = new PiWorkerEngine({
      sessionRoot: root,
      piBinary: process.execPath,
      argsPrefix: [fakePi],
      subagentExtensionPath: "/guest/subagent-extension.js",
      extensionPath: "/guest/cua-extension.js",
      provider: "mock",
      model: "mock-cua",
      env: { ...process.env, FAKE_PI_ARGS_LOG: argsLog, FAKE_PI_ENV_LOG: envLog },
    });
  });

  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("runs prompt, maps events, aborts, archives and natively resumes", async () => {
    const session = await engine.startSession({
      workerId: "worker-1",
      projectId: "project-1",
      vmId: "vm-1",
      workspacePath: root,
      engineType: "pi-rpc",
      systemPrompt: "Operate only the VM desktop",
      capabilities: ["computer_use"],
    });
    expect(session.sessionId).toBe("fake-session");

    const events: WorkerEngineEvent[] = [];
    const turnFinished = new Promise<void>((resolve) => {
      const unsubscribe = engine.subscribe(session.sessionId, (event) => {
        events.push(event);
        if (event.type === "turn_finished") {
          unsubscribe();
          resolve();
        }
      });
    });
    await engine.prompt(session.sessionId, { text: "run" });
    await turnFinished;

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_started",
      "tool_finished",
      "turn_finished",
    ]);
    expect(events[1]).toMatchObject({ toolName: "vm_screenshot" });

    await expect(engine.steer(session.sessionId, { text: "change" })).resolves.toBe("queued");
    await expect(engine.followUp(session.sessionId, { text: "later" })).resolves.toBe("queued");
    await engine.abort(session.sessionId);

    const archive = await engine.archive(session.sessionId);
    expect(archive.archiveRef).toMatch(/[\\/]backups[\\/]worker-1-.*\.jsonl$/);
    expect(archive.summary).toBe("done");

    const startArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(startArgs).toContain("--no-builtin-tools");
    expect(startArgs).toContain("--no-mcp");
    expect(startArgs).toContain("--extension");
    expect(startArgs).toContain("/guest/subagent-extension.js");
    expect(startArgs).toContain("/guest/cua-extension.js");
    expect(startArgs).toContain("--system-prompt");
    const childArgs = JSON.parse(
      (JSON.parse(await readFile(envLog, "utf8")) as { subagentChildArgs: string })
        .subagentChildArgs,
    ) as string[];
    expect(childArgs).toContain("--no-mcp");
    expect(childArgs).toContain("--no-builtin-tools");
    expect(childArgs).toContain("/guest/cua-extension.js");
    expect(childArgs).not.toContain("/guest/subagent-extension.js");

    const resumed = await engine.resume(archive.archiveRef);
    expect(resumed).toMatchObject({ sessionId: "resumed-session", mode: "native" });

    const resumeArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(resumeArgs).toContain("--session");
  });

  it("enables MCP only for an opted-in session and preserves it on native resume", async () => {
    const session = await engine.startSession({
      workerId: "worker-mcp",
      projectId: "project-mcp",
      vmId: "vm-1",
      workspacePath: root,
      engineType: "pi-rpc",
      systemPrompt: "",
      capabilities: ["computer_use"],
      mcpEnabled: true,
    });
    const startArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(startArgs).not.toContain("--no-mcp");
    const childArgs = JSON.parse(
      (JSON.parse(await readFile(envLog, "utf8")) as { subagentChildArgs: string })
        .subagentChildArgs,
    ) as string[];
    expect(childArgs).not.toContain("--no-mcp");
    expect(childArgs).toContain("builtin:mcp");
    expect(childArgs).toContain("builtin:codemode");

    const archive = await engine.archive(session.sessionId);
    await engine.resume(archive.archiveRef);
    const resumeArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(resumeArgs).not.toContain("--no-mcp");
  });

  it("rejects unsupported attachments instead of dropping them", async () => {
    const session = await engine.startSession({
      workerId: "worker-2",
      projectId: "project-1",
      vmId: "vm-1",
      workspacePath: root,
      engineType: "pi-rpc",
      systemPrompt: "",
      capabilities: ["computer_use"],
    });
    await expect(
      engine.prompt(session.sessionId, { text: "read", attachments: ["/etc/passwd"] }),
    ).rejects.toThrow("Unsupported Worker image attachment");
  });
});
