import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repository, "release", "router-runtime");
const piPackageName = "@earendil-works/pi-coding-agent";
const piBinEntry = "dist/bundle/cli.js";
const piCliRelativePath = path.posix.join(
  "pi",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  piBinEntry,
);
const targetPlatforms = Object.freeze([
  Object.freeze({ os: "linux", cpu: "x64", libc: "glibc" }),
  Object.freeze({ os: "win32", cpu: "x64" }),
]);
const lifecycleScriptNames = ["preinstall", "install", "postinstall", "prepare"];

async function main() {
  const appVersion = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ).version;
  const piVersion = readPinnedPiVersion(
    await readFile(path.join(repository, "packages", "agent-runtime", "src", "index.ts"), "utf8"),
  );

  await mkdir(path.dirname(outputDirectory), { recursive: true });
  let staging = await mkdtemp(path.join(path.dirname(outputDirectory), ".router-runtime-staging-"));
  try {
    const tarball = path.join(staging, "pi-coding-agent.tgz");
    const source = await obtainPiTarball(tarball, staging, piVersion);
    const tarballBytes = await readFile(tarball);
    const parsed = parsePiTarball(tarballBytes, piVersion);

    const piRoot = path.join(staging, "pi");
    await installPiForPlatforms(staging, piRoot, piVersion, appVersion);
    await validateInstalledPi(piRoot, piVersion);
    // The installed package tree is the runtime artifact; do not ship the
    // validated npm tarball again inside the installer.
    await rm(tarball, { force: true });

    const modulesRoot = path.join(piRoot, "node_modules");
    const inventory = await inspectRuntimeTree(modulesRoot);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      routerRuntimeVersion: appVersion,
      piPackage: piPackageName,
      piVersion,
      piBin: piBinEntry,
      cli: piCliRelativePath,
      source: {
        kind: source.kind,
        tarballSha256: source.sha256,
        tarballSizeBytes: tarballBytes.byteLength,
        packageJsonSha256: createHash("sha256")
          .update(JSON.stringify(parsed.manifest))
          .digest("hex"),
      },
      platforms: targetPlatforms.map((platform) => ({ ...platform })),
      packageCount: inventory.packages.length,
      packages: inventory.packages,
      nativeModules: inventory.nativeModules,
      lifecycleScripts: inventory.lifecycleScripts,
    };
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
    });

    await rm(outputDirectory, { recursive: true, force: true });
    await rename(staging, outputDirectory);
    staging = null;
    console.log(
      JSON.stringify(
        {
          outputDirectory,
          piVersion,
          cli: piCliRelativePath,
          platforms: manifest.platforms,
          packageCount: manifest.packageCount,
          tarballSha256: manifest.source.tarballSha256,
        },
        null,
        2,
      ),
    );
    if (inventory.nativeModules.length > 0) {
      console.warn(`Router runtime contains native modules: ${inventory.nativeModules.join(", ")}`);
    }
    if (inventory.lifecycleScripts.length > 0) {
      console.warn(
        "Router runtime dependencies declare install-time lifecycle scripts that were not executed: " +
          inventory.lifecycleScripts.map((entry) => entry.path).join(", "),
      );
    }
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export function readPinnedPiVersion(source) {
  const match = /export const PI_ENGINE_VERSION\s*=\s*"([^"]+)"/.exec(source);
  if (!match?.[1]) {
    throw new Error("packages/agent-runtime/src/index.ts does not declare PI_ENGINE_VERSION");
  }
  return match[1];
}

export function validatePiPackageManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Pi package.json is not an object");
  }
  if (manifest.name !== piPackageName) {
    throw new Error(`unexpected Pi package name: ${String(manifest.name)}`);
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Pi package version ${String(manifest.version)} does not match pinned ${expectedVersion}`,
    );
  }
  if (manifest.type !== "module") {
    throw new Error(`Pi package must be ESM, got type=${String(manifest.type)}`);
  }
  if (!manifest.bin || typeof manifest.bin !== "object" || manifest.bin.pi !== piBinEntry) {
    throw new Error(`Pi package bin.pi must be ${piBinEntry}`);
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== "object") {
    throw new Error("Pi package.json does not declare production dependencies");
  }
  return manifest;
}

/**
 * Reject archive members that could escape the extraction root or break on
 * Windows before any package content is installed. npm tarballs use a single
 * `package/` root.
 */
export function assertSafeArchivePath(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("archive entry has an empty path");
  }
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) < 0x20) {
      throw new Error(`archive entry contains control characters: ${JSON.stringify(name)}`);
    }
  }
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (normalized.length === 0) {
    throw new Error("archive entry has an empty path");
  }
  if (normalized.includes("\\")) {
    throw new Error(`archive entry uses a backslash: ${name}`);
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`archive entry is absolute: ${name}`);
  }
  if (/[<>:"|?*]/.test(normalized)) {
    throw new Error(`archive entry is not portable to Windows: ${name}`);
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`archive entry traverses its root: ${name}`);
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error(`archive entry is not portable to Windows: ${name}`);
    }
  }
  if (segments[0] !== "package") {
    throw new Error(`archive entry is outside package/: ${name}`);
  }
}

/**
 * Minimal tar reader for npm tarballs. It parses ustar/PAX/GNU long names and
 * keeps entry bodies in memory so package metadata and the CLI can be checked
 * without extracting or executing package code.
 */
export function parsePiTarball(gzipBytes, expectedVersion) {
  const entries = parseTarEntries(gzipBytes);
  const seen = new Set();
  for (const entry of entries) {
    assertSafeArchivePath(entry.name);
    if (entry.type !== "0" && entry.type !== "5") {
      throw new Error(
        `archive entry has unsupported type ${JSON.stringify(entry.type)}: ${entry.name}`,
      );
    }
    if (entry.type === "0") {
      if (seen.has(entry.name)) {
        throw new Error(`archive contains duplicate file ${entry.name}`);
      }
      seen.add(entry.name);
    }
  }

  const packageJsonEntry = entries.find(
    (entry) => entry.name === "package/package.json" && entry.type === "0",
  );
  if (!packageJsonEntry) {
    throw new Error("Pi tarball does not contain package/package.json");
  }
  let manifest;
  try {
    manifest = JSON.parse(packageJsonEntry.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Pi package.json is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  validatePiPackageManifest(manifest, expectedVersion);

  const cliEntry = entries.find(
    (entry) => entry.name === `package/${piBinEntry}` && entry.type === "0",
  );
  if (!cliEntry || cliEntry.body.byteLength === 0) {
    throw new Error(`Pi tarball does not contain a non-empty ${piBinEntry}`);
  }
  return { entries, manifest };
}

export async function mergeRuntimeTree(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json") {
      continue;
    }
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      throw new Error(`router runtime dependency tree contains a symlink: ${sourcePath}`);
    }
    if (info.isDirectory()) {
      await mergeRuntimeTree(sourcePath, targetPath);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`router runtime dependency tree contains a non-file entry: ${sourcePath}`);
    }
    if (await existsFile(targetPath)) {
      if (entry.name === "package.json") {
        const [sourceBytes, targetBytes] = await Promise.all([
          readFile(sourcePath),
          readFile(targetPath),
        ]);
        if (!sourceBytes.equals(targetBytes)) {
          throw new Error(
            `platform-specific installs resolved different package metadata at ${targetPath}`,
          );
        }
      }
      continue;
    }
    await copyFile(sourcePath, targetPath);
  }
}

async function obtainPiTarball(target, staging, piVersion) {
  const cached = path.join(
    repository,
    "release",
    "guest-runtime",
    "linux-amd64",
    "pi-coding-agent.tgz",
  );
  if (await existsFile(cached)) {
    try {
      const bytes = await readFile(cached);
      parsePiTarball(bytes, piVersion);
      await copyFile(cached, target);
      return {
        kind: "guest-runtime-cache",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      console.warn(
        `cached Pi tarball ${cached} is not usable (${errorMessage(error)}); packing ${piVersion} from npm`,
      );
    }
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(
    npm,
    ["pack", `${piPackageName}@${piVersion}`, "--pack-destination", staging, "--ignore-scripts"],
    {
      cwd: staging,
      env: npmEnvironment(),
      shell: process.platform === "win32",
    },
  );
  const expected = `${piPackageName.replace(/^@/, "").replace("/", "-")}-${piVersion}.tgz`;
  let packed = path.join(staging, expected);
  if (!(await existsFile(packed))) {
    const candidates = (await readdir(staging)).filter((name) => name.endsWith(".tgz"));
    if (candidates.length !== 1) {
      throw new Error(`npm pack did not produce ${expected}`);
    }
    packed = path.join(staging, candidates[0]);
  }
  const bytes = await readFile(packed);
  parsePiTarball(bytes, piVersion);
  if (path.resolve(packed) !== path.resolve(target)) {
    await rename(packed, target);
  }
  return {
    kind: "npm-pack",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function installPiForPlatforms(staging, piRoot, piVersion, appVersion) {
  const installDirectories = [];
  for (const platform of targetPlatforms) {
    const installDirectory = path.join(staging, `install-${platform.os}-${platform.cpu}`);
    await mkdir(installDirectory, { recursive: true });
    const packageJsonPath = path.join(installDirectory, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: "@agent-in-box/router-pi-runtime",
          version: appVersion,
          private: true,
          description: "Packaged host Router Pi runtime",
          dependencies: {
            [piPackageName]: "file:../pi-coding-agent.tgz",
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await run(
      npm,
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--install-links",
        "--os",
        platform.os,
        "--cpu",
        platform.cpu,
        ...(platform.libc ? ["--libc", platform.libc] : []),
      ],
      {
        cwd: installDirectory,
        env: npmEnvironment(),
        shell: process.platform === "win32",
      },
    );

    // Keep the runtime metadata portable: npm initially records a file: path
    // for the local, already-validated tarball.
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: "@agent-in-box/router-pi-runtime",
          version: appVersion,
          private: true,
          description: "Packaged host Router Pi runtime",
          dependencies: {
            [piPackageName]: piVersion,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
    await validateNpmTree(npm, installDirectory, platform);
    installDirectories.push(installDirectory);
  }

  const modulesRoot = path.join(piRoot, "node_modules");
  await mkdir(modulesRoot, { recursive: true });
  for (const installDirectory of installDirectories) {
    await mergeRuntimeTree(path.join(installDirectory, "node_modules"), modulesRoot);
  }
  await writeFile(
    path.join(piRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@agent-in-box/router-pi-runtime",
        version: appVersion,
        private: true,
        description: "Packaged host Router Pi runtime",
        dependencies: {
          [piPackageName]: piVersion,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  for (const installDirectory of installDirectories) {
    await rm(installDirectory, { recursive: true, force: true });
  }
}

async function validateNpmTree(npm, installDirectory, platform) {
  const result = spawnSync(npm, ["ls", "--omit=dev", "--all", "--json"], {
    cwd: installDirectory,
    encoding: "utf8",
    env: npmEnvironment(),
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  let report = null;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {
    // Fall through to the status check with the raw output.
  }
  const problems = Array.isArray(report?.problems) ? report.problems : [];
  if (result.status !== 0 || problems.length > 0) {
    const detail =
      problems.length > 0 ? problems.join("; ") : (result.stderr || result.stdout || "").trim();
    throw new Error(
      `npm could not resolve the ${platform.os}-${platform.cpu} Router Pi dependency tree${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
}

async function validateInstalledPi(piRoot, piVersion) {
  const packageRoot = path.join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!(await existsFile(packageJsonPath))) {
    throw new Error("installed Router Pi package is missing package.json");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`installed Router Pi package.json is invalid: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  validatePiPackageManifest(manifest, piVersion);

  const cliPath = path.join(packageRoot, piBinEntry);
  const cliInfo = await stat(cliPath).catch(() => null);
  if (!cliInfo?.isFile() || cliInfo.size === 0) {
    throw new Error(`installed Router Pi CLI is missing or empty: ${cliPath}`);
  }
  for (const dependency of Object.keys(manifest.dependencies)) {
    const resolved = await resolveInstalledDependency(packageRoot, piRoot, dependency);
    if (!resolved) {
      throw new Error(`installed Router Pi dependency is missing: ${dependency}`);
    }
  }
}

async function resolveInstalledDependency(packageRoot, piRoot, dependency) {
  let directory = packageRoot;
  while (true) {
    const candidate = path.join(directory, "node_modules", dependency, "package.json");
    if (await existsFile(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory || path.relative(piRoot, parent).startsWith("..")) {
      return null;
    }
    directory = parent;
  }
}

async function inspectRuntimeTree(modulesRoot) {
  const packages = [];
  const nativeModules = [];
  const lifecycleScripts = [];

  async function walk(directory, relativeDirectory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`router runtime dependency tree contains a symlink: ${entryPath}`);
      }
      if (entry.isFile()) {
        if (entry.name.endsWith(".node")) nativeModules.push(relativePath);
        continue;
      }
      if (!entry.isDirectory()) {
        throw new Error(`router runtime dependency tree contains a non-file entry: ${entryPath}`);
      }
      if (entry.name === "node_modules") {
        await inspectNodeModules(entryPath, relativePath);
      } else {
        await walk(entryPath, relativePath);
      }
    }
  }

  async function inspectNodeModules(directory, relativeDirectory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`invalid dependency entry: ${entryPath}`);
      }
      if (entry.name.startsWith("@")) {
        const scopedEntries = (await readdir(entryPath, { withFileTypes: true })).sort(
          (left, right) => left.name.localeCompare(right.name),
        );
        for (const scopedEntry of scopedEntries) {
          const scopedPath = path.join(entryPath, scopedEntry.name);
          if (scopedEntry.isSymbolicLink() || !scopedEntry.isDirectory()) {
            throw new Error(`invalid scoped dependency entry: ${scopedPath}`);
          }
          await inspectPackage(
            scopedPath,
            path.posix.join(relativeDirectory, entry.name, scopedEntry.name),
          );
        }
      } else {
        await inspectPackage(entryPath, path.posix.join(relativeDirectory, entry.name));
      }
    }
  }

  async function inspectPackage(packageRoot, relativePath) {
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!(await existsFile(packageJsonPath))) {
      throw new Error(`dependency is missing package.json: ${packageJsonPath}`);
    }
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`dependency has invalid package metadata: ${packageJsonPath}`);
    }
    packages.push({ name: manifest.name, version: manifest.version, path: relativePath });
    for (const scriptName of lifecycleScriptNames) {
      if (manifest.scripts?.[scriptName]) {
        lifecycleScripts.push({
          name: manifest.name,
          version: manifest.version,
          script: scriptName,
          path: relativePath,
        });
      }
    }
    await walk(packageRoot, relativePath);
  }

  await inspectNodeModules(modulesRoot, "pi/node_modules");
  packages.sort((left, right) => left.path.localeCompare(right.path));
  lifecycleScripts.sort((left, right) => left.path.localeCompare(right.path));
  nativeModules.sort();
  return { packages, nativeModules, lifecycleScripts };
}

function parseTarEntries(gzipBytes) {
  const data = gunzipSync(gzipBytes);
  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  let pendingPaxPath = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readCString(header, 0, 100);
    const size = parseTarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readCString(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      throw new Error("Pi tarball is truncated");
    }
    const body = data.subarray(dataStart, dataEnd);

    if (type === "L") {
      pendingLongName = readCString(body, 0, body.length);
    } else if (type === "x") {
      pendingPaxPath = parsePaxPath(body) ?? pendingPaxPath;
    } else if (type === "g") {
      // Global PAX headers carry no per-entry path. Ignore their metadata.
    } else if (type === "0" || type === "5") {
      const entryName =
        pendingLongName ?? pendingPaxPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
      entries.push({ name: entryName, type, body });
      pendingLongName = null;
      pendingPaxPath = null;
    } else {
      throw new Error(`Pi tarball contains unsupported entry type ${JSON.stringify(type)}`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parsePaxPath(body) {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(body.toString("utf8", offset, space));
    if (!Number.isInteger(length) || length <= 0 || offset + length > body.length) break;
    const record = body.toString("utf8", space + 1, offset + length - 1);
    const separator = record.indexOf("=");
    if (separator >= 0) {
      const key = record.slice(0, separator);
      const value = record.slice(separator + 1);
      if (key === "path") return value;
    }
    offset += length;
  }
  return null;
}

function parseTarNumber(header, offset, length) {
  if ((header[offset] & 0x80) !== 0) {
    let value = 0;
    for (let index = 1; index < length; index += 1) {
      value = value * 256 + header[offset + index];
    }
    return value;
  }
  const text = readCString(header, offset, length).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error("Pi tarball has an invalid size field");
  }
  return Number.parseInt(text, 8);
}

function readCString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function npmEnvironment() {
  return {
    ...process.env,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_ignore_scripts: "true",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "null"}`);
  }
}

async function existsFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectInvocation(argv, moduleFile) {
  if (argv[1] === undefined) return false;
  const invoked = path.resolve(argv[1]);
  const modulePath = path.resolve(moduleFile);
  return process.platform === "win32"
    ? invoked.toLowerCase() === modulePath.toLowerCase()
    : invoked === modulePath;
}

const invokedDirectly = isDirectInvocation(process.argv, fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
