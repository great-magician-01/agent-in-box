import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILES = 2048;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_TEST_OUTPUT = 32_000;

/**
 * Built-in Guest development adapter. It is loaded only when the host supplies
 * a Development Worker capability. Tests execute in the explicitly authorized
 * guest workspace; the host only validates/registers the exact tested bytes.
 */
export default function registerPluginDevelopment(pi) {
  pi.registerTool({
    name: "plugin_development_scaffold",
    label: "Create plugin project",
    description:
      "Create a new plugin project from the built-in tested template. Use this before implementing a new plugin.",
    parameters: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Absolute guest-local directory to create",
          minLength: 1,
          maxLength: 512,
        },
        pluginId: {
          type: "string",
          description: "Reverse-domain plugin ID, for example local.weekly-report",
          pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$",
        },
        displayName: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["targetPath", "pluginId", "displayName"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const target = path.resolve(params.targetPath);
      if (!path.isAbsolute(target) || target === path.parse(target).root) {
        throw new Error("Plugin target must be a non-root absolute guest directory");
      }
      const existing = await lstat(target).catch(() => null);
      if (existing) throw new Error("Plugin target already exists; choose a new empty path");
      const template =
        process.env.AGENT_IN_BOX_PLUGIN_TEMPLATE?.trim() ||
        path.join(EXTENSION_DIRECTORY, "..", "plugin-template");
      const files = await readPackage(template);
      for (const file of files) {
        const output = path.join(target, ...file.path.split("/"));
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        const text = Buffer.from(file.dataBase64, "base64")
          .toString("utf8")
          .replaceAll("{{PLUGIN_ID}}", params.pluginId)
          .replaceAll("{{DISPLAY_NAME}}", params.displayName);
        await writeFile(output, text, { flag: "wx", mode: 0o700 });
      }
      return toolResult({
        ok: true,
        root: target,
        pluginId: params.pluginId,
        message:
          "Plugin project created; implement the extension, run tests, then call plugin_development_register",
      });
    },
  });

  pi.registerTool({
    name: "plugin_development_register",
    label: "Test and register plugin",
    description:
      "Validate a local Pi plugin directory, run its npm test suite in this Development Worker, register the exact tested package, and enable it for the current project only when pre-authorized. The directory must contain manifest.json and package.json with a test script.",
    parameters: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description: "Absolute guest-local plugin package directory",
          minLength: 1,
          maxLength: 512,
        },
      },
      required: ["root"],
      additionalProperties: false,
    },
    async execute(_id, params, signal) {
      const root = path.resolve(params.root);
      if (!path.isAbsolute(root) || root === path.parse(root).root) {
        throw new Error("Plugin root must be a non-root absolute guest directory");
      }
      const files = await readPackage(root);
      const inspected = await broker("/v1/inspect", { files }, signal);
      const tested = await runTests(root, signal);
      if (tested.exitCode !== 0) {
        return toolResult({
          ok: false,
          stage: "tests",
          packageSha256: inspected.packageSha256,
          tests: tested,
          message: "Tests failed; the package was not registered",
        });
      }
      const registered = await broker(
        "/v1/register",
        {
          files,
          testReport: {
            status: "passed",
            packageSha256: inspected.packageSha256,
            command: "npm test",
            exitCode: 0,
            durationMs: tested.durationMs,
          },
        },
        signal,
      );
      let enablement = null;
      if (registered.autoEnableAllowed === true) {
        const enabled = await broker(
          "/v1/enable",
          {
            pluginId: registered.plugin.pluginId,
            version: registered.plugin.version,
          },
          signal,
        );
        enablement = enabled.enablement;
      }
      return toolResult({
        ok: true,
        plugin: registered.plugin,
        packageSha256: inspected.packageSha256,
        tests: { ...tested, output: tested.output.slice(-MAX_TEST_OUTPUT) },
        enablement,
        message: enablement
          ? "Plugin registered and enabled for the current project; new Worker sessions will use it"
          : "Plugin registered; local user approval is required before enabling it",
      });
    },
  });
}

async function readPackage(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (["node_modules", ".git", ".staging"].includes(entry.name)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new Error(`Plugin package contains a symlink or unsupported file: ${relative}`);
      }
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) throw new Error(`Plugin file is too large: ${relative}`);
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES || files.length >= MAX_FILES) {
        throw new Error("Plugin package exceeds the development transfer limits");
      }
      const bytes = await readFile(absolute);
      files.push({ path: relative, dataBase64: bytes.toString("base64") });
    }
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Plugin root must be a real directory without symlinks");
  }
  await walk(root);
  if (!files.some((file) => file.path === "manifest.json")) {
    throw new Error("Plugin package is missing manifest.json");
  }
  if (!files.some((file) => file.path === "package.json")) {
    throw new Error("Plugin package is missing package.json with a test script");
  }
  return files;
}

async function runTests(root, signal) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    // The test process must not hold the registration/enablement capability;
    // only this extension performs the host-validated register call.
    const testEnv = { ...process.env, CI: "1", NO_COLOR: "1", NODE_ENV: "test" };
    delete testEnv.AGENT_IN_BOX_PLUGIN_DEV_URL;
    delete testEnv.AGENT_IN_BOX_PLUGIN_DEV_TOKEN;
    const child = spawn(command, ["test"], {
      cwd: root,
      shell: false,
      env: testEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        output: `${output}\nTests timed out`,
      });
    }, 120_000);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_TEST_OUTPUT);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_TEST_OUTPUT);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish({ exitCode: code ?? -1, durationMs: Date.now() - startedAt, output });
    });
  });
}

async function broker(endpoint, body, signal) {
  const baseUrl = (process.env.AGENT_IN_BOX_PLUGIN_DEV_URL ?? "").replace(/\/$/, "");
  const token = process.env.AGENT_IN_BOX_PLUGIN_DEV_TOKEN ?? "";
  if (!baseUrl || !token) throw new Error("Plugin development broker is not configured");
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error?.message ?? `Plugin development broker HTTP ${response.status}`);
  }
  return payload;
}

function toolResult(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}
