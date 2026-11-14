import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeArchivePath,
  mergeRuntimeTree,
  readPinnedPiVersion,
  validatePiPackageManifest,
} from "../../../scripts/package-router-runtime.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-router-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("package-router-runtime", () => {
  it("reads the pinned Pi engine version from the runtime source", () => {
    expect(readPinnedPiVersion('export const PI_ENGINE_VERSION = "1.5.1" as const;')).toBe("1.5.1");
    expect(() => readPinnedPiVersion("export const OTHER = 1;")).toThrow(
      /does not declare PI_ENGINE_VERSION/,
    );
  });

  it("accepts only the pinned ESM Pi package with the expected bin entry", () => {
    const manifest = {
      name: "@earendil-works/pi-coding-agent",
      version: "1.5.1",
      type: "module",
      bin: { pi: "dist/bundle/cli.js" },
      dependencies: { typebox: "1.3.27" },
    };
    expect(validatePiPackageManifest(manifest, "1.5.1")).toBe(manifest);
    expect(() => validatePiPackageManifest({ ...manifest, version: "1.5.2" }, "1.5.1")).toThrow(
      /does not match pinned/,
    );
    expect(() => validatePiPackageManifest({ ...manifest, type: "commonjs" }, "1.5.1")).toThrow(
      /must be ESM/,
    );
    expect(() =>
      validatePiPackageManifest({ ...manifest, bin: { pi: "dist/cli.js" } }, "1.5.1"),
    ).toThrow(/bin\.pi/);
  });

  it("rejects archive paths that escape package/ or are not portable", () => {
    expect(() => assertSafeArchivePath("package/dist/bundle/cli.js")).not.toThrow();
    expect(() => assertSafeArchivePath("package/")).not.toThrow();
    for (const unsafe of [
      "../package.json",
      "/package.json",
      "C:/package.json",
      "package/../../package.json",
      "package/..\\package.json",
      "other/package.json",
      "package/with?query",
      "package/control\u0001name",
    ]) {
      expect(() => assertSafeArchivePath(unsafe), unsafe).toThrow();
    }
  });

  it("merges per-platform dependency trees without shipping symlinks or lock metadata", async () => {
    const root = await temporaryDirectory();
    const linuxModules = path.join(root, "linux", "node_modules");
    const windowsModules = path.join(root, "windows", "node_modules");
    const targetModules = path.join(root, "target", "node_modules");
    await mkdir(path.join(linuxModules, "shared"), { recursive: true });
    await mkdir(path.join(linuxModules, ".bin"), { recursive: true });
    await mkdir(path.join(linuxModules, "linux-native"), { recursive: true });
    await mkdir(path.join(windowsModules, "shared"), { recursive: true });
    await mkdir(path.join(windowsModules, "win32-native"), { recursive: true });
    await writeFile(path.join(linuxModules, "shared", "package.json"), '{"name":"shared"}\n');
    await writeFile(path.join(linuxModules, "shared", "index.js"), "shared\n");
    await writeFile(path.join(linuxModules, "linux-native", "package.json"), '{"name":"linux"}\n');
    await writeFile(path.join(windowsModules, "shared", "package.json"), '{"name":"shared"}\n');
    await writeFile(
      path.join(windowsModules, "win32-native", "package.json"),
      '{"name":"win32"}\n',
    );
    await writeFile(path.join(linuxModules, ".package-lock.json"), "{}\n");
    await writeFile(path.join(linuxModules, ".bin", "tool"), "shim\n");

    await mergeRuntimeTree(linuxModules, targetModules);
    await mergeRuntimeTree(windowsModules, targetModules);

    await expect(readFile(path.join(targetModules, "shared", "index.js"), "utf8")).resolves.toBe(
      "shared\n",
    );
    await expect(
      readFile(path.join(targetModules, "win32-native", "package.json"), "utf8"),
    ).resolves.toContain("win32");
    await expect(
      readFile(path.join(targetModules, "linux-native", "package.json"), "utf8"),
    ).resolves.toContain("linux");
    await expect(readFile(path.join(targetModules, ".package-lock.json"))).rejects.toThrow();
    await expect(readFile(path.join(targetModules, ".bin", "tool"))).rejects.toThrow();

    const conflictingModules = path.join(root, "conflicting", "node_modules");
    await mkdir(path.join(conflictingModules, "shared"), { recursive: true });
    await writeFile(
      path.join(conflictingModules, "shared", "package.json"),
      '{"name":"shared","version":"2"}\n',
    );
    await expect(mergeRuntimeTree(conflictingModules, targetModules)).rejects.toThrow(
      /different package metadata/,
    );
  });
});
