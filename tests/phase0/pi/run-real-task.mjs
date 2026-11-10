// Generic real-model task runner for the phase-0 acceptance set.
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);
const taskId = process.argv[2];
const tasks = JSON.parse(fs.readFileSync(new URL("./real-tasks.json", import.meta.url), "utf8"));
const task = tasks.find((entry) => entry.id === taskId);
if (!task) throw new Error(`unknown real task ${taskId}; available: ${tasks.map((entry) => entry.id).join(", ")}`);

const work = process.env.AIB_PI_WORK || "/home/aib/pi-real-validation";
const extension = process.env.AIB_PI_EXTENSION || "/home/aib/pi-validation/cua-extension.js";
const piBinary = process.env.AIB_PI_BINARY || "/home/aib/pi-validation/npm-global/bin/pi";
const model = process.env.AIB_REAL_MODEL || "pro";
fs.mkdirSync(work, { recursive: true });
const eventLog = path.join(work, `${task.id}-events.jsonl`);
const resultPath = path.join(work, `${task.id}-result.json`);
fs.writeFileSync(eventLog, "");

const result = {
  name: task.id,
  taskId: task.taskId,
  model,
  startedAt: new Date().toISOString(),
  checks: {},
  errors: [],
};
let buffer = "";
let nextId = 1;
const pending = new Map();
const listeners = new Set();
let exited = false;

const child = spawn(piBinary, [
  "--mode", "rpc",
  "--session-dir", path.join(work, "sessions"),
  "--provider", "broker",
  "--model", model,
  "-e", extension,
], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });

child.on("exit", (code, signal) => {
  exited = true;
  for (const entry of pending.values()) entry.reject(new Error(`Pi exited ${code}/${signal}`));
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
    fs.appendFileSync(eventLog, JSON.stringify(event) + "\n");
    if (event.type === "response" && event.id) {
      const entry = pending.get(event.id);
      if (entry) {
        pending.delete(event.id);
        if (event.success) entry.resolve(event.data);
        else entry.reject(new Error(event.error || "Pi command failed"));
      }
    } else {
      for (const listener of listeners) listener(event);
    }
  }
});

function command(type, fields = {}) {
  const id = `req-${nextId++}`;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  return promise;
}

function waitForSettled(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("task did not settle")), timeoutMs);
    const listener = (event) => {
      if (event.type === "agent_settled") {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(event);
      }
    };
    listeners.add(listener);
  });
}

async function main() {
  if (task.setup) {
    await execAsync(task.setup, { env: process.env, shell: "/bin/bash" });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const state = await command("get_state");
  result.checks.modelSelected = state.model?.id === model;
  const settled = waitForSettled(240000);
  await command("prompt", { message: task.prompt });
  await settled;
  result.checks.runSettled = true;

  const verification = await execAsync(task.verify, { env: process.env, shell: "/bin/bash" }).catch((error) => ({
    stdout: error.stdout || "",
    stderr: error.stderr || "",
    code: error.code || 1,
  }));
  result.verify = verification;
  if (task.verifyType === "sha256") {
    result.checks.taskVerified = verification.stdout?.startsWith(task.expectedSha256) || false;
  } else {
    result.checks.taskVerified = Boolean(verification.stdout?.trim()) && (verification.code === 0 || verification.code === undefined);
  }

  const events = fs.readFileSync(eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  result.toolExecutionStarts = events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
  result.checks.usedScreenshot = result.toolExecutionStarts.includes("vm_screenshot");
  result.status = Object.values(result.checks).every(Boolean) ? "passed" : "failed";
}

main()
  .catch((error) => {
    result.status = "failed";
    result.errors.push(error.stack || String(error));
  })
  .finally(() => {
    if (!exited) {
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 2000).unref();
    }
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  });
