import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const extensionPath = fileURLToPath(
  new URL("../extensions/subagent-extension.js", import.meta.url),
);
const fakePi = fileURLToPath(new URL("./testing/fake-subagent-pi.mjs", import.meta.url));

interface SubagentParams {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
}

interface ChildResult {
  agent: string;
  status: string;
  output: string;
  errorMessage: string | null;
}

interface ToolResult {
  details: { mode: string; results: ChildResult[]; isError: boolean };
}

interface SubagentTool {
  execute(
    id: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: {
      cwd: string;
      model: { provider: string; id: string };
      thinkingLevel: string;
    },
  ): Promise<ToolResult>;
}

const ENV_KEYS = [
  "AGENT_IN_BOX_SUBAGENT_CHILD_ARGS",
  "AGENT_IN_BOX_PI_SCRIPT",
  "AGENT_IN_BOX_PI_BINARY",
  "FAKE_SUBAGENT_LOG_DIR",
] as const;

describe("Worker subagent extension", () => {
  let root: string;
  let tool: SubagentTool;
  let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aib-subagent-extension-"));
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
      (typeof ENV_KEYS)[number],
      string | undefined
    >;
    process.env.AGENT_IN_BOX_PI_SCRIPT = fakePi;
    process.env.AGENT_IN_BOX_PI_BINARY = process.execPath;
    process.env.FAKE_SUBAGENT_LOG_DIR = root;
    process.env.AGENT_IN_BOX_SUBAGENT_CHILD_ARGS = JSON.stringify([
      "--no-extensions",
      "--extension",
      "/guest/cua-extension.js",
      "--no-mcp",
      "--no-builtin-tools",
    ]);

    const { default: register } = await import(pathToFileURL(extensionPath).href);
    let registered: SubagentTool | undefined;
    register({
      on: () => undefined,
      registerTool: (definition: SubagentTool) => {
        registered = definition;
      },
    });
    if (!registered) throw new Error("subagent tool was not registered");
    tool = registered;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("runs a child with the inherited model and security arguments", async () => {
    const result = await tool.execute(
      "call-1",
      { agent: "scout", task: "inspect" },
      undefined,
      undefined,
      {
        cwd: root,
        model: { provider: "mock", id: "mock-cua" },
        thinkingLevel: "low",
      },
    );
    expect(result.details.isError).toBe(false);
    expect(result.details.results[0]).toMatchObject({ agent: "scout", status: "completed" });
    expect(result.details.results[0]?.output).toContain("Delegated task\ninspect");

    const [log] = await readdir(root);
    const child = JSON.parse(await readFile(path.join(root, log!), "utf8")) as {
      args: string[];
      childArgs: string;
    };
    expect(child.args).toContain("--no-mcp");
    expect(child.args).toContain("--no-builtin-tools");
    expect(child.args).toContain("--no-extensions");
    expect(child.args).toContain("/guest/cua-extension.js");
    expect(child.args).not.toContain("subagent-extension.js");
    expect(child.args.slice(child.args.indexOf("--model") + 1)[0]).toBe("mock/mock-cua");
    expect(child.args.slice(child.args.indexOf("--thinking") + 1)[0]).toBe("low");
    expect(JSON.parse(child.childArgs)).toContain("--no-mcp");
  });

  it("passes prior output through a chain", async () => {
    const result = await tool.execute(
      "call-chain",
      {
        chain: [
          { agent: "scout", task: "first" },
          { agent: "reviewer", task: "review {previous}" },
        ],
      },
      undefined,
      undefined,
      { cwd: root, model: { provider: "mock", id: "mock-cua" }, thinkingLevel: "low" },
    );
    expect(result.details.mode).toBe("chain");
    expect(result.details.results.map((child) => child.status)).toEqual(["completed", "completed"]);
    expect(result.details.results[1]?.output).toContain("review child result:");
  });

  it("supports parallel results and aborts an active child", async () => {
    const parallel = await tool.execute(
      "call-2",
      {
        tasks: [
          { agent: "planner", task: "one" },
          { agent: "reviewer", task: "two" },
        ],
      },
      undefined,
      undefined,
      { cwd: root, model: { provider: "mock", id: "mock-cua" }, thinkingLevel: "low" },
    );
    expect(parallel.details.results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);

    const controller = new AbortController();
    const pending = tool.execute(
      "call-3",
      { agent: "worker", task: "[hold]" },
      controller.signal,
      undefined,
      { cwd: root, model: { provider: "mock", id: "mock-cua" }, thinkingLevel: "low" },
    );
    await waitForChild();
    controller.abort();
    const aborted = await pending;
    expect(aborted.details.results[0]?.status).toBe("aborted");
    expect(aborted.details.isError).toBe(true);
  });

  async function waitForChild(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await readdir(root)).length >= 3) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the held subagent");
  }
});
