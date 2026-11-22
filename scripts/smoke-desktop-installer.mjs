import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * Installs (Windows) or runs (Linux AppImage) the real release artifact and
 * verifies that the packaged application can start its control plane. The
 * directory-package smoke covers the unpacked tree; this covers the installer
 * and AppImage launcher that users actually execute.
 */
const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-install-smoke-"));
const configDirectory = path.join(temporary, "config");
const reportPath = path.join(temporary, "report.json");

function findArtifact(pattern) {
  const matches = readdirSync(path.join(root, "release")).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${pattern} artifact, found ${matches.join(", ") || "none"}`,
    );
  }
  return path.join(root, "release", matches[0]);
}

function smokeEnvironment() {
  return {
    ...process.env,
    AGENT_IN_BOX_CONFIG_DIR: configDirectory,
    AGENT_IN_BOX_SMOKE_EXIT_MS: process.env.AGENT_IN_BOX_SMOKE_EXIT_MS ?? "12000",
    AGENT_IN_BOX_SMOKE_REPORT: reportPath,
    CONTROL_PLANE_PORT: process.env.SMOKE_CONTROL_PLANE_PORT ?? "3993",
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
}

async function runSmoke(executable, args, label) {
  if (!existsSync(executable)) throw new Error(`${label} executable not found: ${executable}`);
  console.log(`[installer-smoke] launching ${label}: ${executable}`);
  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env: smokeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 90_000)),
  ]);
  if (exitCode === "timeout") {
    child.kill("SIGKILL");
    throw new Error(`${label} smoke timed out\n${output.slice(-4000)}`);
  }
  if (!existsSync(reportPath)) {
    throw new Error(`${label} exited with ${String(exitCode)} without a smoke report\n${output}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.ok, true, `${label} must start its control plane`);
  assert.equal(typeof report.version, "string", `${label} must report its package version`);
  return report;
}

async function main() {
  try {
    if (process.platform === "win32") {
      const installer = findArtifact(/^agent-in-box-.*-windows-x64\.exe$/);
      const installDirectory = path.join(temporary, "app");
      console.log(`[installer-smoke] installing ${installer} into ${installDirectory}`);
      const install = spawnSync(installer, ["/S", `/D=${installDirectory}`], {
        stdio: "inherit",
      });
      if (install.status !== 0) {
        throw new Error(`NSIS installer exited with ${String(install.status)}`);
      }
      const executable = path.join(installDirectory, "Agent-in-Box.exe");
      await runSmoke(executable, [], "installed Agent-in-Box");
      const uninstaller = readdirSync(installDirectory).find((name) =>
        /^Uninstall .*\.exe$/i.test(name),
      );
      if (uninstaller) {
        const removed = spawnSync(path.join(installDirectory, uninstaller), ["/S"], {
          stdio: "inherit",
        });
        if (removed.status !== 0) {
          throw new Error(`uninstaller exited with ${String(removed.status)}`);
        }
      }
      return;
    }

    if (process.platform === "linux") {
      const appImage = findArtifact(/^agent-in-box-.*-linux-x64\.AppImage$/);
      chmodSync(appImage, 0o755);
      await runSmoke(
        appImage,
        ["--appimage-extract-and-run", "--no-sandbox", "--disable-gpu"],
        "AppImage",
      );
      return;
    }

    throw new Error(`installer smoke is not implemented for ${process.platform}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
