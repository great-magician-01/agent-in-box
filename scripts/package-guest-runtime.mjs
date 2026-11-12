import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repository, "release", "guest-runtime", "linux-amd64");
const version = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")).version;
const nodeVersion = "24.18.0";
const piVersion = "1.5.1";
const nodeArchiveName = `node-v${nodeVersion}-linux-x64.tar.xz`;
const piPackageName = `earendil-works-pi-coding-agent-${piVersion}.tgz`;

const staging = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-guest-runtime-"));
const artifacts = [];

try {
  await mkdir(outputDirectory, { recursive: true });

  const guestAgentSource = path.join(staging, "guest-agent-linux-amd64");
  await run(
    "go",
    ["build", "-trimpath", "-o", guestAgentSource, "./services/guest-agent/cmd/guest-agent"],
    {
      cwd: repository,
      env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
    },
  );
  await addArtifact("guest-agent", "guest-agent-linux-amd64", guestAgentSource);

  await run(process.execPath, [path.join(repository, "scripts", "package-worker-runtime.mjs")], {
    cwd: repository,
    env: process.env,
  });
  const workerArchiveName = `agent-in-box-worker-${version}.tar.gz`;
  await addArtifact(
    "worker-runtime.tar.gz",
    workerArchiveName,
    path.join(repository, "release", "worker-runtime", workerArchiveName),
  );

  const cachedNode = path.join(outputDirectory, nodeArchiveName);
  if (await existsFile(cachedNode)) {
    await addArtifact("node-linux-x64.tar.xz", nodeArchiveName, cachedNode);
  } else {
    const nodeDownload = path.join(staging, nodeArchiveName);
    await downloadWithRetry(
      `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`,
      nodeDownload,
    );
    const sums = await downloadTextWithRetry(
      `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
    );
    const expectedNodeHash = parseSha256Sums(sums, nodeArchiveName);
    await assertSha256(nodeDownload, expectedNodeHash);
    await addArtifact("node-linux-x64.tar.xz", nodeArchiveName, nodeDownload);
  }

  const cachedPi = path.join(outputDirectory, "pi-coding-agent.tgz");
  if (await existsFile(cachedPi)) {
    await addArtifact("pi-coding-agent.tgz", piPackageName, cachedPi);
  } else {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await run(
      npm,
      ["pack", `@earendil-works/pi-coding-agent@${piVersion}`, "--pack-destination", staging],
      {
        cwd: staging,
        env: process.env,
        shell: process.platform === "win32",
      },
    );
    const packedPi = path.join(staging, `earendil-works-pi-coding-agent-${piVersion}.tgz`);
    await addArtifact("pi-coding-agent.tgz", piPackageName, packedPi);
  }

  for (const [assetName, source] of [
    ["install.sh", "images/linux/worker-runtime/install.sh"],
    ["agent-in-box-worker.service", "images/linux/worker-runtime/agent-in-box-worker.service"],
    ["worker.env.example", "images/linux/worker-runtime/worker.env.example"],
    ["cua-extension.js", "images/linux/worker-runtime/cua-extension.js"],
    [
      "agent-in-box-guest-agent.service",
      "images/linux/guest-agent/agent-in-box-guest-agent.service",
    ],
  ]) {
    await addArtifact(assetName, assetName, path.join(repository, source));
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    guestRuntimeVersion: version,
    profile: "linux-desktop-worker",
    nodeVersion,
    piVersion,
    assets: artifacts,
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  console.log(JSON.stringify({ outputDirectory, artifacts }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function addArtifact(name, fileName, source) {
  const target = path.join(outputDirectory, name);
  if (path.resolve(source) !== path.resolve(target)) {
    await copyFile(source, target);
  } else if (await existsFile(`${target}.sha256`)) {
    const expected = (await readFile(`${target}.sha256`, "utf8")).trim().split(/\s+/)[0];
    if (expected) await assertSha256(target, expected.toLowerCase());
  }
  const bytes = await readFile(target);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${target}.sha256`, `${sha256}  ${name}\n`, { mode: 0o644 });
  artifacts.push({ name, fileName, sizeBytes: bytes.byteLength, sha256 });
}

async function existsFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function downloadWithRetry(url, target) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await download(url, target);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadTextWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await downloadText(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function download(url, target) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`download failed: ${url} HTTP ${response.status}`);
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  const { createWriteStream } = await import("node:fs");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o600 }));
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed: ${url} HTTP ${response.status}`);
  return response.text();
}

function parseSha256Sums(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === fileName && hash && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain ${fileName}`);
}

async function assertSha256(file, expected) {
  const bytes = await readFile(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}`);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "null"}`);
  }
}
