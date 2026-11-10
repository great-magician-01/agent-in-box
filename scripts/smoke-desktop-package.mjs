import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-desktop-smoke-"));
const configDirectory = path.join(temporary, "config");
const reportPath = path.join(temporary, "report.json");

function executablePath() {
  if (process.platform === "win32") {
    return path.join(root, "release", "win-unpacked", "Agent-in-Box.exe");
  }
  if (process.platform === "darwin") {
    return path.join(
      root,
      "release",
      "mac",
      "Agent-in-Box.app",
      "Contents",
      "MacOS",
      "Agent-in-Box",
    );
  }
  return path.join(root, "release", "linux-unpacked", "@agent-in-boxdesktop");
}

async function main() {
  const executable = executablePath();
  const env = {
    ...process.env,
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    AGENT_IN_BOX_SMOKE_EXIT_MS: process.env.AGENT_IN_BOX_SMOKE_EXIT_MS ?? "8000",
    AGENT_IN_BOX_SMOKE_REPORT: reportPath,
    CONTROL_PLANE_PORT: process.env.SMOKE_CONTROL_PLANE_PORT ?? "0",
  };
  if (env.CONTROL_PLANE_PORT === "0") {
    env.CONTROL_PLANE_PORT = "3992";
  }
  if (process.env.AGENT_IN_BOX_SMOKE_LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = process.env.AGENT_IN_BOX_SMOKE_LD_LIBRARY_PATH;
  }

  const args = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
  console.log(`[desktop-smoke] launching ${executable}`);
  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 60_000)),
  ]);

  if (exitCode === "timeout") {
    child.kill("SIGKILL");
    throw new Error(`desktop smoke timed out\n${output.slice(-4000)}`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.ok, true, "control plane must be running in the packaged app");
  assert.equal(report.renderer.bridge, "object", "preload bridge must be exposed");
  assert.equal(report.renderer.requireType, "undefined", "renderer must not have require()");
  assert.equal(report.renderer.processType, "undefined", "renderer must not have Node process");
  assert.ok(
    report.renderer.url.startsWith("http://127.0.0.1:"),
    "renderer must load the local control plane UI",
  );
  assert.match(
    report.renderer.text,
    /首次启动向导|环境检查/,
    "React renderer must show the first-run wizard for a fresh data directory",
  );
  console.log("[desktop-smoke] packaged desktop shell passed");
}

try {
  await main();
} catch (error) {
  console.error(`[desktop-smoke] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
