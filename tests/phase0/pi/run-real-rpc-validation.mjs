// Real-model Pi Computer Use validation through the local Model Broker.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const work = process.env.AIB_PI_WORK || "/home/aib/pi-real-validation";
const extension = process.env.AIB_PI_EXTENSION || "/home/aib/pi-validation/cua-extension.js";
const piBinary = process.env.AIB_PI_BINARY || "/home/aib/pi-validation/npm-global/bin/pi";
const model = process.env.AIB_REAL_MODEL || "pro";
fs.mkdirSync(work, { recursive: true });
const eventLog = path.join(work, "rpc-events.jsonl");
const resultPath = path.join(work, "real-model-result.json");
fs.writeFileSync(eventLog, "");

const result = {
  name: "pi-real-model-computer-use",
  model,
  startedAt: new Date().toISOString(),
  checks: {},
  errors: [],
};
const marker = "/tmp/aib-real-model-ok";
const expected = "你好-real-model\n";
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
    const timer = setTimeout(() => reject(new Error("real-model run did not settle")), timeoutMs);
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
  const state = await command("get_state");
  result.checks.modelSelected = state.model?.id === model;
  const settled = waitForSettled(240000);
  await command("prompt", {
    message: [
      "Operate the Linux VM using only the vm_* tools.",
      "A maximized terminal is already open and focused.",
      `Type exactly: echo 你好-real-model > ${marker}`,
      "Then press enter. Take a screenshot first to confirm the desktop, and a final screenshot after typing.",
      "Do not use read/write/edit/bash tools for this task.",
    ].join("\n"),
  });
  await settled;
  result.checks.runSettled = true;

  const content = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  result.checks.guestTaskVerified = content === expected;
  result.guestContentSha256 = content ? crypto.createHash("sha256").update(content).digest("hex") : null;
  result.expectedSha256 = crypto.createHash("sha256").update(expected).digest("hex");
  const messages = await command("get_messages");
  result.messageCount = messages.messages.length;

  const toolEvents = fs.readFileSync(eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  result.toolExecutionStarts = toolEvents.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
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
