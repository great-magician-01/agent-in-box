// Drives Pi RPC against the script-driven mock model and the real guest agent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const work = process.env.AIB_PI_WORK || "/tmp/aib-pi-validation";
const extension = process.env.AIB_PI_EXTENSION || path.join(work, "cua-extension.js");
const piBinary = process.env.AIB_PI_BINARY || "pi";
fs.mkdirSync(work, { recursive: true });
const eventLog = path.join(work, "rpc-events.jsonl");
const resultPath = path.join(work, "pi-rpc-result.json");
fs.writeFileSync(eventLog, "");

const result = {
  name: "pi-rpc-computer-use-mock-model",
  startedAt: new Date().toISOString(),
  checks: {},
  errors: [],
};
let child;
let childEvents;
let buffer = "";
let nextId = 1;
const pending = new Map();
let exited = false;

function recordEvent(event) {
  fs.appendFileSync(eventLog, JSON.stringify(event) + "\n");
}

function waitForEvent(predicate, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for Pi event")), timeoutMs);
    const listener = (event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        childEvents.delete(listener);
        resolve(event);
      }
    };
    childEvents.add(listener);
  });
}

function command(type, fields = {}) {
  const id = `req-${nextId++}`;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  return promise;
}

function startPi(sessionFile) {
  exited = false;
  buffer = "";
  childEvents = new Set();
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    path.join(work, "sessions"),
    "--provider",
    "mock",
    "--model",
    "mock-cua",
    "-e",
    extension,
  ];
  if (sessionFile) args.push("--session", sessionFile);
  child = spawn(piBinary, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("exit", (code, signal) => {
    exited = true;
    for (const entry of pending.values()) {
      entry.reject(new Error(`Pi exited code=${code} signal=${signal}`));
    }
    pending.clear();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      recordEvent(event);
      if (event.type === "response" && event.id) {
        const entry = pending.get(event.id);
        if (entry) {
          pending.delete(event.id);
          if (event.success) entry.resolve(event.data);
          else entry.reject(new Error(event.error || "Pi command failed"));
        }
      } else {
        for (const listener of childEvents) listener(event);
      }
    }
  });
}

async function main() {
  startPi();
  const state = await command("get_state");
  result.checks.modelSelected = state.model?.id === "mock-cua";
  result.checks.sessionCreated = Boolean(state.sessionId);

  const settled = waitForEvent((event) => event.type === "agent_settled", 90000);
  await command("prompt", { message: "Run the mock Computer Use task" });
  await settled;
  result.checks.toolLoopSettled = true;

  const messages = await command("get_messages");
  result.checks.messageCount = messages.messages.length;
  const finalState = await command("get_state");
  result.sessionFile = finalState.sessionFile;

  const guestMarker = "/tmp/aib-pi-cua-ok";
  const content = fs.existsSync(guestMarker) ? fs.readFileSync(guestMarker, "utf8") : "";
  result.checks.guestTaskVerified = content === "你好-pi\n";
  result.guestContentSha256 = content
    ? (await import("node:crypto")).createHash("sha256").update(content).digest("hex")
    : null;

  // Abort a run that is waiting inside a tool call.
  const slowSettled = waitForEvent((event) => event.type === "agent_settled", 30000);
  await command("prompt", { message: "slow test" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await command("abort");
  await slowSettled;
  result.checks.abortCompleted = true;

  const beforeResume = await command("get_messages");
  const resumeFile = result.sessionFile;
  child.stdin.end();
  const deadline = Date.now() + 15000;
  while (!exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!exited) child.kill("SIGTERM");

  if (resumeFile) {
    startPi(resumeFile);
    const resumed = await command("get_messages");
    result.checks.sessionResume =
      resumed.messages.length >= beforeResume.messages.length && beforeResume.messages.length > 0;
    result.resumedMessageCount = resumed.messages.length;
  } else {
    result.errors.push("Pi did not report a session file");
  }

  const mockLog = process.env.MOCK_MODEL_LOG || "/tmp/aib-mock-model.jsonl";
  if (fs.existsSync(mockLog)) {
    const records = fs
      .readFileSync(mockLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    result.checks.screenshotReturnedToModel = records.some(
      (record) => record.sawPngBase64 && record.toolResults >= 1,
    );
    result.checks.allCuaToolsExposed = records.every((record) =>
      ["vm_screenshot", "vm_click", "vm_type_text", "vm_keypress", "vm_wait"].every((tool) =>
        record.tools.includes(tool),
      ),
    );
    result.checks.abortUsedWaitTool = records.some(
      (record) => record.decision.tool?.function?.name === "vm_wait",
    );
    result.mockRequests = records.length;
  }

  result.status = Object.values(result.checks).every(Boolean) ? "passed" : "failed";
}

main()
  .catch((error) => {
    result.status = "failed";
    result.errors.push(error.stack || String(error));
  })
  .finally(() => {
    if (child && !exited) {
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 2000).unref();
    }
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  });
