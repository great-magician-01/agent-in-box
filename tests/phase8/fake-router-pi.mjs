// Fake host Router Pi RPC process for the phase 8 smoke test.
// It speaks the real Pi JSONL protocol and calls the real Router Tool Broker
// with the short-lived token supplied through the process environment.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1] || "/tmp";
const resumed = args.includes("--session");
const sessionFile = resumed
  ? args[args.indexOf("--session") + 1]
  : path.join(sessionDir, "phase8-router.jsonl");
fs.mkdirSync(sessionDir, { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "");
if (process.env.PHASE8_ROUTER_ARGS_LOG) {
  fs.writeFileSync(
    process.env.PHASE8_ROUTER_ARGS_LOG,
    JSON.stringify({ args, resumed, sessionFile }),
  );
}
if (process.env.PHASE8_ROUTER_ENV_LOG) {
  fs.writeFileSync(
    process.env.PHASE8_ROUTER_ENV_LOG,
    JSON.stringify({
      routerUrl: process.env.AGENT_IN_BOX_ROUTER_URL || "",
      hasToken: Boolean(process.env.AGENT_IN_BOX_ROUTER_TOKEN),
      provider: process.env.AGENT_IN_BOX_ROUTER_PROVIDER || "",
      model: process.env.AGENT_IN_BOX_ROUTER_MODEL || "",
    }),
  );
}

function write(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function response(id, command, data) {
  write({ id, type: "response", command, success: true, data });
}

function fail(id, command, error) {
  write({ id, type: "response", command, success: false, error });
}

async function tool(name, args) {
  const url = (process.env.AGENT_IN_BOX_ROUTER_URL || "").replace(/\/$/, "");
  const token = process.env.AGENT_IN_BOX_ROUTER_TOKEN || "";
  if (!url || !token) throw new Error("Router tool broker environment is missing");
  const reply = await fetch(`${url}/v1/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args ?? {}),
  });
  const payload = await reply.json();
  if (!reply.ok || payload?.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

async function runScenario(message) {
  const projectId = process.env.PHASE8_PROJECT_ID || "";
  const objective = process.env.PHASE8_OBJECTIVE || "[hold] Phase 8 smoke task";
  const secondObjective = process.env.PHASE8_SECOND_OBJECTIVE || "Phase 8 archive follow-up";
  if (message.includes("CREATE-FIRST")) {
    const projects = await tool("list_projects", {});
    const target = projects.find((project) => project.projectId === projectId) ?? projects[0];
    if (!target) throw new Error("no project is available");
    const workers = await tool("list_active_workers", { projectId: target.projectId });
    const related = await tool("find_related_worker", {
      projectId: target.projectId,
      objective,
    });
    const worker = workers[0];
    if (worker) {
      const assigned = await tool("assign_task", {
        workerId: worker.workerId,
        objective,
      });
      return `assigned task ${assigned.task.id} to worker ${worker.workerId}; related=${related.suggestions.length}`;
    }
    const created = await tool("create_task", {
      projectId: target.projectId,
      objective,
      idempotencyKey: "phase8-smoke-first-task",
    });
    return `created task ${created.task.id}; related=${related.suggestions.length}`;
  }
  if (message.includes("AFTER-ARCHIVE")) {
    const archives = await tool("search_worker_archive", {
      projectId,
      query: "Phase 8",
    });
    const tasks = await tool("list_tasks", { projectId, statuses: ["running", "queued"] });
    const created = await tool("create_task", {
      projectId,
      objective: secondObjective,
      idempotencyKey: "phase8-smoke-second-task",
    });
    return `archives=${archives.items.length}; activeTasks=${tasks.length}; created=${created.task.id}`;
  }
  if (message.includes("AFTER-RESTART")) {
    const tasks = await tool("list_tasks", { projectId });
    const board = await tool("get_board_summary", {});
    const archives = await tool("search_worker_archive", { projectId, query: "" });
    return `tasks=${tasks.length}; archives=${archives.items.length}; boardTasks=${board.taskCount}`;
  }
  const projects = await tool("list_projects", {});
  return `projects=${projects.length}`;
}

process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type !== "prompt") {
      switch (command.type) {
        case "get_state":
          response(command.id, "get_state", {
            sessionId: resumed ? "phase8-router-resumed" : "phase8-router",
            sessionFile,
            model: { id: process.env.AGENT_IN_BOX_ROUTER_MODEL || "router-model" },
          });
          break;
        case "get_messages":
          response(command.id, "get_messages", {
            messages: [
              { role: "user", content: "phase8" },
              { role: "assistant", content: [{ type: "text", text: "smoke" }] },
            ],
          });
          break;
        case "steer":
        case "follow_up":
          response(command.id, command.type, { disposition: "queued" });
          break;
        case "abort":
          response(command.id, "abort", {});
          setImmediate(() => write({ type: "agent_settled" }));
          break;
        default:
          fail(command.id, command.type, "unsupported");
      }
      continue;
    }
    response(command.id, "prompt", { disposition: "started" });
    setImmediate(async () => {
      let text;
      try {
        text = await runScenario(String(command.message ?? ""));
      } catch (error) {
        text = `Router scenario error: ${error instanceof Error ? error.message : String(error)}`;
      }
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      write({ type: "agent_settled" });
    });
  }
});

process.stdin.on("end", () => process.exit(0));
