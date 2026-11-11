// Fake Pi RPC process used by agent-runtime tests. It speaks the real JSONL
// protocol but never contacts a model or a VM.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1] || "/tmp";
const resumed = args.includes("--session");
const sessionFile = resumed
  ? args[args.indexOf("--session") + 1]
  : path.join(sessionDir, "fake-session.jsonl");
fs.mkdirSync(sessionDir, { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "");
if (process.env.FAKE_PI_ARGS_LOG) {
  fs.writeFileSync(process.env.FAKE_PI_ARGS_LOG, JSON.stringify(args));
}
if (process.env.FAKE_PI_ENV_LOG) {
  fs.writeFileSync(
    process.env.FAKE_PI_ENV_LOG,
    JSON.stringify({
      cuaUrl: process.env.AGENT_IN_BOX_CUA_URL || "",
      cuaToken: process.env.AGENT_IN_BOX_CUA_TOKEN || "",
    }),
  );
}

function write(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function response(id, command, data) {
  write({ id, type: "response", command, success: true, data });
}

process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (process.env.FAKE_PI_COMMAND_LOG) {
      fs.appendFileSync(
        process.env.FAKE_PI_COMMAND_LOG,
        JSON.stringify({ type: command.type }) + "\n",
      );
    }
    switch (command.type) {
      case "get_state":
        response(command.id, "get_state", {
          sessionId: resumed ? "resumed-session" : "fake-session",
          sessionFile,
          model: { id: "mock-cua" },
        });
        break;
      case "get_messages":
        response(command.id, "get_messages", {
          messages: [
            { role: "user", content: "task" },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
          ],
        });
        break;
      case "prompt": {
        const hold = String(command.message ?? "").startsWith("[hold]");
        response(command.id, "prompt", { disposition: "started" });
        setImmediate(() => {
          write({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "working" },
          });
          write({ type: "tool_execution_start", toolName: "vm_screenshot", args: {} });
          if (!hold) {
            write({
              type: "tool_execution_end",
              toolName: "vm_screenshot",
              result: { ok: true },
              isError: false,
            });
            write({ type: "agent_settled" });
          }
        });
        break;
      }
      case "steer":
      case "follow_up":
        response(command.id, command.type, { disposition: "queued" });
        break;
      case "abort":
        response(command.id, "abort", {});
        setImmediate(() => {
          write({
            type: "tool_execution_end",
            toolName: "vm_screenshot",
            result: { aborted: true },
            isError: true,
          });
          write({ type: "agent_settled" });
        });
        break;
      default:
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: "unsupported",
        });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
