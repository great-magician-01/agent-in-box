import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PLUGIN_SCHEMA_VERSION,
  PluginPackageError,
  inspectPluginPackage,
  resolvePluginEntry,
  type PluginTarget,
  type PluginValidationIssue,
} from "./index";

const temporaryRoots: string[] = [];

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: "com.example.plugin",
    version: "1.0.0",
    displayName: "Example Plugin",
    apiVersion: PLUGIN_API_VERSION,
    targets: ["worker"],
    entrypoints: { worker: "dist/extension.js" },
    runtime: { kind: "pi-extension", minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
    permissions: [],
    tools: [],
    dependencies: [],
    ...overrides,
  };
}

async function createTempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-in-box-plugin-"));
  temporaryRoots.push(root);
  return root;
}

async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

interface CreatePackageOptions {
  manifest?: unknown;
  manifestText?: string;
  files?: Record<string, string | Buffer>;
}

async function createPackage(options: CreatePackageOptions = {}): Promise<string> {
  const root = await createTempDir();
  const files = options.files ?? {
    "dist/extension.js": "export default function activate() { return 'ok'; }\n",
  };
  await writeFiles(root, files);
  const manifestText =
    options.manifestText ?? JSON.stringify(options.manifest ?? baseManifest(), null, 2);
  await writeFile(path.join(root, "manifest.json"), manifestText);
  return root;
}

async function trySymlink(
  target: string,
  linkPath: string,
  type: "file" | "dir",
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw error;
  }
}

async function capturePackageError(promise: Promise<unknown>): Promise<PluginPackageError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PluginPackageError) return error;
    throw error;
  }
  throw new Error("Expected a PluginPackageError");
}

function expectPackageIssue(
  error: PluginPackageError,
  code: PluginValidationIssue["code"],
  issuePath?: string,
): void {
  expect(error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        ...(issuePath === undefined ? {} : { path: issuePath }),
      }),
    ]),
  );
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("inspectPluginPackage", () => {
  it("inspects a valid package, hashes every file and is deterministic", async () => {
    const files = {
      "dist/extension.js": "export default function activate() { return 'ok'; }\n",
      "assets/data.txt": "hello\n",
    };
    const root = await createPackage({ files });
    const first = await inspectPluginPackage(root);

    expect(first.root).toBe(await realpath(root));
    expect(first.manifest.id).toBe("com.example.plugin");
    expect(first.manifest.targets).toEqual(["worker"]);
    expect(first.files.map((file) => file.path)).toEqual([
      "assets/data.txt",
      "dist/extension.js",
      "manifest.json",
    ]);
    expect(first.totalFiles).toBe(3);

    let expectedBytes = 0;
    for (const file of first.files) {
      const absolutePath = path.join(root, ...file.path.split("/"));
      const content = await readFile(absolutePath);
      expectedBytes += content.byteLength;
      expect(file.size).toBe(content.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    }
    expect(first.totalBytes).toBe(expectedBytes);
    expect(first.packageSha256).toMatch(/^[0-9a-f]{64}$/);

    const copyRoot = await createPackage({ files });
    const second = await inspectPluginPackage(copyRoot);
    expect(second.files).toEqual(first.files);
    expect(second.packageSha256).toBe(first.packageSha256);
  });

  it("changes file and package hashes when any content changes", async () => {
    const root = await createPackage();
    const before = await inspectPluginPackage(root);

    await writeFile(
      path.join(root, "dist", "extension.js"),
      "export default function activate() { return 'changed'; }\n",
    );
    const afterEntryChange = await inspectPluginPackage(root);
    const beforeEntry = before.files.find((file) => file.path === "dist/extension.js");
    const afterEntry = afterEntryChange.files.find((file) => file.path === "dist/extension.js");
    expect(beforeEntry).toBeDefined();
    expect(afterEntry).toBeDefined();
    expect(afterEntry?.sha256).not.toBe(beforeEntry?.sha256);
    expect(afterEntryChange.packageSha256).not.toBe(before.packageSha256);

    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify(baseManifest({ description: "Changed manifest" }), null, 2),
    );
    const afterManifestChange = await inspectPluginPackage(root);
    const beforeManifest = before.files.find((file) => file.path === "manifest.json");
    const afterManifest = afterManifestChange.files.find((file) => file.path === "manifest.json");
    expect(afterManifest?.sha256).not.toBe(beforeManifest?.sha256);
    expect(afterManifestChange.manifest.description).toBe("Changed manifest");
    expect(afterManifestChange.packageSha256).not.toBe(afterEntryChange.packageSha256);
  });

  it("rejects malformed manifest JSON", async () => {
    const root = await createPackage({ manifestText: "{" });
    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "invalid_json", "manifest.json");
  });

  it("rejects an invalid manifest before walking the package", async () => {
    const root = await createPackage({
      manifest: baseManifest({
        id: "Not-A-Domain",
        entrypoints: { worker: "../outside.js" },
      }),
      files: {},
    });
    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "invalid_id", "manifest.id");
    expectPackageIssue(error, "unsafe_path", "manifest.entrypoints.worker");
  });

  it("rejects traversal and absolute entrypoints", async () => {
    for (const entry of ["../outside.js", "dist/../../outside.js", "/etc/passwd"]) {
      const root = await createPackage({
        manifest: baseManifest({ entrypoints: { worker: entry } }),
        files: {},
      });
      const error = await capturePackageError(inspectPluginPackage(root));
      expectPackageIssue(error, "unsafe_path", "manifest.entrypoints.worker");
    }
  });

  it("rejects a package without manifest.json", async () => {
    const root = await createTempDir();
    await writeFiles(root, { "dist/extension.js": "export default 1;\n" });
    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "missing_manifest", "manifest.json");
  });

  it("rejects symlinked files", async () => {
    const outsideRoot = await createTempDir();
    const outsideFile = path.join(outsideRoot, "extension.js");
    await writeFile(outsideFile, "outside");
    const root = await createPackage({ files: {} });
    await mkdir(path.join(root, "dist"), { recursive: true });
    if (!(await trySymlink(outsideFile, path.join(root, "dist", "extension.js"), "file"))) {
      return;
    }

    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "symlink", "dist/extension.js");
  });

  it("rejects symlinked directories that escape the package", async () => {
    const outsideRoot = await createTempDir();
    await writeFile(path.join(outsideRoot, "extension.js"), "outside");
    const root = await createPackage({ files: {} });
    if (!(await trySymlink(outsideRoot, path.join(root, "dist"), "dir"))) {
      return;
    }

    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "symlink", "dist");
  });

  it("rejects missing entrypoints", async () => {
    const root = await createPackage({ files: {} });
    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "missing_entrypoint", "entrypoints.worker");
  });

  it("rejects entrypoints that point at directories", async () => {
    const root = await createPackage({
      manifest: baseManifest({ entrypoints: { worker: "dist" } }),
      files: { "dist/other.js": "export default 1;\n" },
    });
    const error = await capturePackageError(inspectPluginPackage(root));
    expectPackageIssue(error, "entrypoint_not_file", "entrypoints.worker");
  });

  it("bounds file count, file size, total size and manifest size", async () => {
    const countRoot = await createPackage({
      files: { "a.txt": "a", "b.txt": "b", "dist/extension.js": "entry" },
    });
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(countRoot, { maxFiles: 2 })),
      "too_many_files",
      "files",
    );

    const fileSizeRoot = await createPackage({
      files: { "big.bin": "x".repeat(2_048), "dist/extension.js": "entry" },
    });
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(fileSizeRoot, { maxFileBytes: 1_024 })),
      "file_too_large",
      "big.bin",
    );

    const totalSizeRoot = await createPackage({
      files: { "big.bin": "x".repeat(100), "dist/extension.js": "entry" },
    });
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(totalSizeRoot, { maxTotalBytes: 10 })),
      "package_too_large",
      "files",
    );

    const manifestSizeRoot = await createPackage();
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(manifestSizeRoot, { maxManifestBytes: 10 })),
      "manifest_too_large",
      "manifest.json",
    );
  });

  it("rejects invalid inspection limits", async () => {
    const root = await createPackage();
    const error = await capturePackageError(inspectPluginPackage(root, { maxFiles: 0 }));
    expectPackageIssue(error, "invalid_value", "options.maxFiles");
  });

  it("rejects missing and non-directory roots", async () => {
    const missingRoot = path.join(await createTempDir(), "missing");
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(missingRoot)),
      "invalid_root",
      "root",
    );

    const fileRoot = path.join(await createTempDir(), "not-a-directory");
    await writeFile(fileRoot, "file");
    expectPackageIssue(
      await capturePackageError(inspectPluginPackage(fileRoot)),
      "invalid_root",
      "root",
    );
  });

  it("never executes plugin code", async () => {
    const root = await createTempDir();
    const marker = path.join(root, "executed.marker");
    await writeFiles(root, {
      "dist/extension.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    });
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(baseManifest(), null, 2));

    const inspected = await inspectPluginPackage(root);
    expect(inspected.manifest.id).toBe("com.example.plugin");
    await expect(lstat(path.join(root, "executed.marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("resolvePluginEntry", () => {
  it("resolves declared worker and router entrypoints inside the package", async () => {
    const root = await createPackage({
      manifest: baseManifest({
        targets: ["worker", "router"],
        entrypoints: { worker: "dist/worker.js", router: "dist/router.js" },
      }),
      files: {
        "dist/worker.js": "worker",
        "dist/router.js": "router",
      },
    });

    const workerEntry = await resolvePluginEntry(root, "worker");
    const routerEntry = await resolvePluginEntry(root, "router");
    expect(workerEntry).toBe(await realpath(path.join(root, "dist", "worker.js")));
    expect(routerEntry).toBe(await realpath(path.join(root, "dist", "router.js")));
    expect(path.isAbsolute(workerEntry)).toBe(true);
  });

  it("rejects targets that the manifest does not declare", async () => {
    const root = await createPackage();
    const error = await capturePackageError(resolvePluginEntry(root, "router"));
    expectPackageIssue(error, "missing_entrypoint", "entrypoints.router");
  });

  it("rejects unsupported targets", async () => {
    const root = await createPackage();
    const error = await capturePackageError(
      resolvePluginEntry(root, "desktop" as unknown as PluginTarget),
    );
    expectPackageIssue(error, "unsupported_target", "target");
  });

  it("rejects missing entrypoint files", async () => {
    const root = await createPackage({ files: {} });
    const error = await capturePackageError(resolvePluginEntry(root, "worker"));
    expectPackageIssue(error, "missing_entrypoint", "entrypoints.worker");
  });

  it("rejects symlinked entrypoint files and parent directories", async () => {
    const outsideRoot = await createTempDir();
    const outsideFile = path.join(outsideRoot, "extension.js");
    await writeFile(outsideFile, "outside");

    const fileRoot = await createPackage({ files: {} });
    await mkdir(path.join(fileRoot, "dist"), { recursive: true });
    if (await trySymlink(outsideFile, path.join(fileRoot, "dist", "extension.js"), "file")) {
      const error = await capturePackageError(resolvePluginEntry(fileRoot, "worker"));
      expectPackageIssue(error, "symlink", "entrypoints.worker");
    }

    const directoryRoot = await createPackage({ files: {} });
    if (await trySymlink(outsideRoot, path.join(directoryRoot, "dist"), "dir")) {
      const error = await capturePackageError(resolvePluginEntry(directoryRoot, "worker"));
      expectPackageIssue(error, "symlink", "entrypoints.worker");
    }
  });

  it("rejects traversal entrypoints before resolving them", async () => {
    const root = await createPackage({
      manifest: baseManifest({ entrypoints: { worker: "../escape.js" } }),
      files: {},
    });
    const error = await capturePackageError(resolvePluginEntry(root, "worker"));
    expectPackageIssue(error, "unsafe_path", "manifest.entrypoints.worker");
  });

  it("never executes an entrypoint while resolving it", async () => {
    const root = await createTempDir();
    const marker = path.join(root, "executed.marker");
    await writeFiles(root, {
      "dist/extension.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    });
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(baseManifest(), null, 2));

    const entry = await resolvePluginEntry(root, "worker");
    expect(entry).toBe(await realpath(path.join(root, "dist", "extension.js")));
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
