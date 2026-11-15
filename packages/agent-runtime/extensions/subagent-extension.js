import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Process-isolated subagents for Agent-in-Box's Pi RPC Workers.
 *
 * This follows Pi 1.5.1's examples/extensions/subagent delegation model, but
 * removes interactive/project-agent loading and inherits the parent's explicit
 * security policy through AGENT_IN_BOX_SUBAGENT_CHILD_ARGS. Children never load
 * this extension themselves, so delegation cannot recursively spawn delegators.
 */

const AGENTS = {
  scout: {
    description: "Read-only investigation and compressed findings",
    prompt:
      "You are a scout subagent. Investigate the delegated task using only available tools. Do not modify files, applications, or system state. Return concise findings, evidence, and relevant paths or locations for the parent agent.",
  },
  planner: {
    description: "Implementation planning without making changes",
    prompt:
      "You are a planner subagent. Analyze the delegated task and produce a concrete, ordered plan. Do not modify files, applications, or system state. Identify risks, dependencies, and verification steps for the parent agent.",
  },
  reviewer: {
    description: "Read-only quality, correctness, and security review",
    prompt:
      "You are a reviewer subagent. Review the delegated work using only available tools. Do not modify files, applications, or system state. Report concrete findings first, ordered by severity, and include supporting evidence.",
  },
  worker: {
    description: "General delegated execution with the parent's tool permissions",
    prompt:
      "You are a worker subagent in an isolated context. Complete only the delegated task using the tools available to you. Stay within the parent's instructions and permissions. Return a concise result, changes made, and any blockers or verification evidence.",
  },
};

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_STDERR_CHARS = 32_000;
const MAX_UNTERMINATED_LINE_BYTES = 16 * 1024 * 1024;

const stringSchema = (description, maximumLength) => ({
  type: "string",
  description,
  minLength: 1,
  ...(maximumLength ? { maxLength: maximumLength } : {}),
});

const TaskItem = {
  type: "object",
  properties: {
    agent: stringSchema("Built-in agent name"),
    task: stringSchema("Task to delegate", 100_000),
  },
  required: ["agent", "task"],
  additionalProperties: false,
};

// Pi accepts TypeBox-compatible JSON Schema. Keeping the schema plain makes
// this Worker asset self-contained in both Pi's loader and direct Node tests.
const SubagentParams = {
  type: "object",
  properties: {
    agent: stringSchema("Agent for single mode"),
    task: stringSchema("Task for single mode", 100_000),
    tasks: {
      type: "array",
      description: "Independent tasks for parallel mode",
      items: TaskItem,
      maxItems: MAX_TASKS,
    },
    chain: {
      type: "array",
      description: "Sequential tasks; {previous} inserts the prior result",
      items: TaskItem,
      maxItems: MAX_TASKS,
    },
  },
  additionalProperties: false,
};

function inheritedChildArgs() {
  const fallback = [
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-builtin-tools",
  ];
  const raw = process.env.AGENT_IN_BOX_SUBAGENT_CHILD_ARGS;
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_IN_BOX_SUBAGENT_CHILD_ARGS is not valid JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 128 ||
    parsed.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("AGENT_IN_BOX_SUBAGENT_CHILD_ARGS must be a bounded string array");
  }
  return parsed;
}

function piInvocation(args) {
  const configuredScript = process.env.AGENT_IN_BOX_PI_SCRIPT?.trim();
  if (configuredScript) {
    return {
      command: process.env.AGENT_IN_BOX_PI_BINARY?.trim() || process.execPath,
      args: [configuredScript, ...args],
    };
  }

  const currentScript = process.argv[1];
  const isBunVirtualScript =
    currentScript &&
    (currentScript.startsWith("/$bunfs/root/") ||
      /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function assistantText(message) {
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function failed(result) {
  return result.status === "failed" || result.status === "aborted";
}

function resultText(result) {
  const output = result.output || "(no output)";
  const evidence = [result.errorMessage, result.stderr.trim()].filter(Boolean).join("\n\n");
  return failed(result) && evidence ? `${output}\n\n${evidence}` : output;
}

function capped(value) {
  return value.length <= MAX_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated]`;
}

async function mapWithConcurrencyLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(null)
    .map(async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index], index);
      }
    });
  await Promise.all(workers);
  return results;
}

async function runAgent(agentName, task, defaults, signal, onUpdate) {
  const agent = Object.hasOwn(AGENTS, agentName) ? AGENTS[agentName] : undefined;
  const result = {
    agent: agentName,
    task,
    status: "running",
    output: "",
    stderr: "",
    exitCode: null,
    turns: 0,
    stopReason: null,
    errorMessage: null,
  };
  const emit = () => onUpdate?.({ ...result });
  if (!agent) {
    result.status = "failed";
    result.errorMessage = `Unknown agent "${agentName}". Available: ${Object.keys(AGENTS).join(", ")}`;
    emit();
    return result;
  }
  if (signal?.aborted) {
    result.status = "aborted";
    result.errorMessage = "Subagent was aborted before starting";
    emit();
    return result;
  }

  const args = ["--mode", "json", "-p", "--no-session", ...inheritedChildArgs()];
  if (defaults.model) args.push("--model", defaults.model);
  if (defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
  args.push(`${agent.prompt}\n\n## Delegated task\n${task}`);
  emit();

  let wasAborted = false;
  const outcome = await new Promise((resolve) => {
    let child;
    let settled = false;
    let exited = false;
    let buffer = "";
    let killTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortProcess);
      resolve(value);
    };
    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const text = assistantText(event.message);
      if (text) result.output = text;
      result.turns += 1;
      result.stopReason = event.message.stopReason ?? null;
      result.errorMessage = event.message.errorMessage ?? null;
      emit();
    };
    const abortProcess = () => {
      if (exited || settled || child.exitCode !== null || child.signalCode !== null) return;
      wasAborted = true;
      if (!child.kill("SIGTERM")) return;
      killTimer = setTimeout(() => {
        if (!exited && !settled) child.kill("SIGKILL");
      }, 5000);
      killTimer.unref();
    };

    try {
      const invocation = piInvocation(args);
      // A delegated child must not inherit the Development Worker capability;
      // only the explicitly loaded development extension may use that token.
      const childEnv = { ...process.env };
      delete childEnv.AGENT_IN_BOX_PLUGIN_DEV_URL;
      delete childEnv.AGENT_IN_BOX_PLUGIN_DEV_TOKEN;
      child = spawn(invocation.command, invocation.args, {
        cwd: defaults.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (error) {
      finish({ spawnError: error });
      return;
    }
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_UNTERMINATED_LINE_BYTES) {
        result.errorMessage = "Subagent exceeded the maximum unterminated JSON event size";
        child.kill("SIGTERM");
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => {
      result.stderr = `${result.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_CHARS);
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code, terminationSignal) => {
      if (buffer.trim()) processLine(buffer);
      finish({ code, signal: terminationSignal });
    });
    child.on("error", (error) => finish({ spawnError: error }));
    if (signal?.aborted) abortProcess();
    else signal?.addEventListener("abort", abortProcess, { once: true });
  });

  result.exitCode = outcome.code ?? null;
  if (wasAborted) {
    result.status = "aborted";
    result.errorMessage ||= "Subagent was aborted";
  } else if (outcome.spawnError) {
    result.status = "failed";
    result.errorMessage = `Failed to spawn subagent: ${String(outcome.spawnError.message || outcome.spawnError)}`;
  } else if (outcome.signal) {
    result.status = "failed";
    result.errorMessage ||= `Subagent terminated by signal ${outcome.signal}`;
  } else if (outcome.code !== 0) {
    result.status = "failed";
    result.errorMessage ||= `Subagent exited with code ${outcome.code}`;
  } else if (result.stopReason === "aborted") {
    result.status = "aborted";
  } else if (result.stopReason === "error") {
    result.status = "failed";
  } else {
    result.status = "completed";
  }
  emit();
  return result;
}

function response(mode, results, forceError = false) {
  const text = results
    .map((result) => `### ${result.agent}: ${result.status}\n\n${capped(resultText(result))}`)
    .join("\n\n---\n\n");
  return {
    content: [{ type: "text", text: text || "No subagent task was run" }],
    details: {
      mode,
      results,
      isError: forceError || results.some(failed),
    },
  };
}

export default function registerSubagent(pi) {
  pi.on("tool_result", (event) => {
    if (event.toolName === "subagent" && event.details?.isError) return { isError: true };
    return undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate to process-isolated built-in subagents: scout, planner, reviewer, worker.",
      "Modes: single ({agent, task}), parallel ({tasks: [...]}), or chain ({chain: [...]} with {previous}).",
      `Parallel accepts at most ${MAX_TASKS} tasks and runs ${MAX_CONCURRENCY} concurrently.`,
      "Children inherit the current model, workspace, tool restrictions, and MCP setting; recursive delegation is disabled.",
    ].join(" "),
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
        return response("single", [], true);
      }
      const defaults = {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };

      if (hasSingle) {
        const result = await runAgent(params.agent, params.task, defaults, signal, (current) => {
          onUpdate?.({
            content: [{ type: "text", text: capped(resultText(current)) }],
            details: { mode: "single", results: [current], isError: failed(current) },
          });
        });
        return response("single", [result]);
      }

      if (hasTasks) {
        const current = new Array(params.tasks.length);
        const emit = () =>
          onUpdate?.({
            content: [{ type: "text", text: "Parallel subagents are running" }],
            details: {
              mode: "parallel",
              results: current.filter(Boolean),
              isError: current.some((result) => result && failed(result)),
            },
          });
        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (item, index) => {
            const result = await runAgent(item.agent, item.task, defaults, signal, (update) => {
              current[index] = update;
              emit();
            });
            current[index] = result;
            emit();
            return result;
          },
        );
        return response("parallel", results);
      }

      const results = [];
      let previous = "";
      for (let index = 0; index < params.chain.length; index += 1) {
        const item = params.chain[index];
        const task = item.task.replace(/\{previous\}/g, previous);
        const result = await runAgent(item.agent, task, defaults, signal, (currentResult) => {
          onUpdate?.({
            content: [{ type: "text", text: capped(resultText(currentResult)) }],
            details: {
              mode: "chain",
              results: [...results, currentResult],
              isError: failed(currentResult),
            },
          });
        });
        results.push(result);
        if (failed(result)) break;
        previous = result.output;
      }
      return response("chain", results);
    },
  });
}
