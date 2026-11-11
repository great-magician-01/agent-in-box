// Fake host Router Pi RPC process for the phase 10 smoke test.
// It speaks the real Pi JSONL protocol and calls the real Router Tool Broker
// with the short-lived token supplied through the process environment.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1] || "/tmp";
const resumed = args.includes("--session");
const sessionFile = resumed
  ? args[args.indexOf("--session") + 1]
  : path.join(sessionDir, "phase10-router.jsonl");
fs.mkdirSync(sessionDir, { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "");

function write(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function response(id, command, data) {
  write({ id, type: "response", command, success: true, data });
}

function fail(id, command, error) {
  write({ id, type: "response", command, success: false, error });
}

async function tool(name, toolArgs) {
  const url = (process.env.AGENT_IN_BOX_ROUTER_URL || "").replace(/\/$/, "");
  const token = process.env.AGENT_IN_BOX_ROUTER_TOKEN || "";
  if (!url || !token) throw new Error("Router tool broker environment is missing");
  const reply = await fetch(`${url}/v1/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(toolArgs ?? {}),
  });
  const payload = await reply.json();
  if (!reply.ok || payload?.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

async function runScenario(message) {
  const projectId = process.env.PHASE10_PROJECT_ID || "";
  if (message.includes("BOT-CREATE")) {
    const projects = await tool("list_projects", {});
    const target = projects.find((project) => project.projectId === projectId) ?? projects[0];
    if (!target) throw new Error("no project is available");
    const created = await tool("create_task", {
      projectId: target.projectId,
      objective: "Phase 10 bot-created task",
      idempotencyKey: "phase10-bot-task",
    });
    return `created task ${created.task.id} for project ${target.projectId}`;
  }
  if (message.includes("BOT-STATUS")) {
    const tasks = await tool("list_tasks", { projectId });
    return `phase10 tasks=${tasks.length}`;
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
            sessionId: resumed ? "phase10-router-resumed" : "phase10-router",
            sessionFile,
            model: { id: process.env.AGENT_IN_BOX_ROUTER_MODEL || "router-model" },
          });
          break;
        case "get_messages":
          response(command.id, "get_messages", {
            messages: [
              { role: "user", content: "phase10" },
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
