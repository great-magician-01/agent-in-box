import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPluginPackage } from "@agent-in-box/plugin-runtime";
import { PiWorkerEngine, type WorkerPluginPackageSpec, type WorkerSessionSpec } from "./index";

const fakePi = fileURLToPath(new URL("./testing/fake-pi.mjs", import.meta.url));
const PLUGIN_ID = "com.example.echo";
const PLUGIN_VERSION = "1.0.0";
const ENTRY = "lib/extension.js";

async function readArgs(file: string): Promise<string[]> {
  return JSON.parse(await readFile(file, "utf8")) as string[];
}

function extensionArgs(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--extension" && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

describe("PiWorkerEngine plugin materialization", () => {
  let dir: string;
  let sessionRoot: string;
  let packageRoot: string;
  let argsLog: string;
  let sentinel: string;
  let entryContent: string;
  let engine: PiWorkerEngine;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aib-pi-plugin-"));
    sessionRoot = path.join(dir, "sessions");
    packageRoot = path.join(dir, "package");
    argsLog = path.join(dir, "pi-args.json");
    sentinel = path.join(dir, "plugin-code-executed");
    entryContent =
      'import { writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(sentinel)}, "executed");\n` +
      'export default "echo";\n';

    await mkdir(path.join(packageRoot, "lib"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: PLUGIN_ID,
        version: PLUGIN_VERSION,
        displayName: "Echo plugin",
        apiVersion: 1,
        targets: ["worker"],
        entrypoints: { worker: ENTRY },
        runtime: { kind: "pi-extension", minPiVersion: "1.5.0", minAppVersion: "0.1.0" },
      }),
    );
    await writeFile(path.join(packageRoot, ENTRY), entryContent);
    await writeFile(path.join(packageRoot, "lib", "data.json"), '{"kind":"fixture"}\n');

    engine = new PiWorkerEngine({
      sessionRoot,
      piBinary: process.execPath,
      argsPrefix: [fakePi],
      env: { ...process.env, FAKE_PI_ARGS_LOG: argsLog },
    });
  });

  afterEach(async () => {
    await engine.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function sessionSpec(
    workerId: string,
    pluginPackages?: readonly WorkerPluginPackageSpec[],
  ): WorkerSessionSpec {
    return {
      workerId,
      projectId: "project-1",
      vmId: "vm-1",
      workspacePath: dir,
      engineType: "pi-rpc",
      systemPrompt: "",
      capabilities: ["filesystem"],
      ...(pluginPackages ? { pluginPackages } : {}),
    };
  }

  async function pluginSpec(): Promise<WorkerPluginPackageSpec> {
    const inspected = await inspectPluginPackage(packageRoot);
    return {
      pluginId: inspected.manifest.id,
      version: inspected.manifest.version,
      packageSha256: inspected.packageSha256,
      entryPath: inspected.manifest.entrypoints.worker ?? "",
      files: await Promise.all(
        inspected.files.map(async (file) => ({
          path: file.path,
          dataBase64: (await readFile(path.join(inspected.root, ...file.path.split("/")))).toString(
            "base64",
          ),
        })),
      ),
    };
  }

  function expectedEntry(workerId: string): string {
    return path.join(sessionRoot, workerId, "plugins", PLUGIN_ID, PLUGIN_VERSION, ENTRY);
  }

  function materializedRoot(workerId: string): string {
    return path.join(sessionRoot, workerId, "plugins", PLUGIN_ID, PLUGIN_VERSION);
  }

  async function readSessionManifest(workerId: string): Promise<{
    plugins?: Array<{
      pluginId: string;
      version: string;
      packageSha256: string;
      packageRoot: string;
      entryPath: string;
    }>;
  }> {
    return JSON.parse(
      await readFile(path.join(sessionRoot, workerId, "session.json"), "utf8"),
    ) as never;
  }

  it("materializes the package and passes its cached entry to Pi via --extension", async () => {
    const spec = await pluginSpec();
    const session = await engine.startSession(sessionSpec("worker-plugin", [spec]));
    expect(session.sessionId).toBe("fake-session");

    const args = await readArgs(argsLog);
    expect(extensionArgs(args)).toEqual([expectedEntry("worker-plugin")]);

    expect(await readFile(expectedEntry("worker-plugin"), "utf8")).toBe(entryContent);
    expect(
      JSON.parse(
        await readFile(path.join(materializedRoot("worker-plugin"), "lib", "data.json"), "utf8"),
      ),
    ).toEqual({ kind: "fixture" });

    const manifest = await readSessionManifest("worker-plugin");
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins?.[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      packageSha256: spec.packageSha256,
      packageRoot: materializedRoot("worker-plugin"),
      entryPath: expectedEntry("worker-plugin"),
    });

    // Inspection and delivery only move bytes; plugin code must never run.
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a transferred package whose content does not match its declared hash", async () => {
    const spec = await pluginSpec();
    const tampered: WorkerPluginPackageSpec = {
      ...spec,
      files: spec.files.map((file) =>
        file.path === ENTRY
          ? { ...file, dataBase64: Buffer.from('export default "tampered";\n').toString("base64") }
          : file,
      ),
    };

    await expect(engine.startSession(sessionSpec("worker-bad-hash", [tampered]))).rejects.toThrow(
      "identity or hash mismatch",
    );
    await expect(
      access(path.join(materializedRoot("worker-bad-hash"), ENTRY)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies cached packages and restores their --extension on native resume", async () => {
    const spec = await pluginSpec();
    const session = await engine.startSession(sessionSpec("worker-resume", [spec]));
    const archive = await engine.archive(session.sessionId);

    const resumed = await engine.resume(archive.archiveRef);
    expect(resumed).toMatchObject({ sessionId: "resumed-session", mode: "native" });

    const args = await readArgs(argsLog);
    expect(args).toContain("--session");
    expect(extensionArgs(args)).toEqual([expectedEntry("worker-resume")]);
    expect(await readFile(expectedEntry("worker-resume"), "utf8")).toBe(entryContent);

    const manifest = await readSessionManifest("worker-resume");
    expect(manifest.plugins?.[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      packageSha256: spec.packageSha256,
      entryPath: expectedEntry("worker-resume"),
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails resume when the cached plugin package fails integrity verification", async () => {
    const spec = await pluginSpec();
    const session = await engine.startSession(sessionSpec("worker-tampered", [spec]));
    const archive = await engine.archive(session.sessionId);
    await writeFile(expectedEntry("worker-tampered"), 'export default "tampered";\n');

    await expect(engine.resume(archive.archiveRef)).rejects.toThrow(
      "failed session integrity verification",
    );
  });
});
