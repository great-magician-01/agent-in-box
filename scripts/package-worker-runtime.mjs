import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(repository, "packages", "agent-runtime");
const outputDirectory = path.join(repository, "release", "worker-runtime");
const version = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")).version;
const filename = `agent-in-box-worker-${version}.tar.gz`;

await mkdir(outputDirectory, { recursive: true });
// Stage next to the archive: a relative path between the archive and the
// staging directory stays colon-free only when both live on the same drive.
const staging = await mkdtemp(path.join(outputDirectory, ".staging-"));
try {
  const dist = path.join(staging, "dist");
  await mkdir(dist, { recursive: true });
  await copyFile(
    path.join(runtimeRoot, "dist", "worker-rpc-main.js"),
    path.join(dist, "worker-rpc-main.js"),
  );
  await copyFile(path.join(runtimeRoot, "dist", "index.js"), path.join(dist, "index.js"));
  for (const module of [
    "pi-engine.js",
    "pi-launch.js",
    "pi-rpc-process.js",
    "worker-rpc-client.js",
    "worker-rpc-server.js",
  ]) {
    await copyFile(path.join(runtimeRoot, "dist", module), path.join(dist, module));
  }
  await mkdir(path.join(staging, "extensions"), { recursive: true });
  await copyFile(
    path.join(runtimeRoot, "extensions", "subagent-extension.js"),
    path.join(staging, "extensions", "subagent-extension.js"),
  );
  await writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: "@agent-in-box/worker-runtime",
        version,
        private: true,
        main: "dist/worker-rpc-main.js",
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );

  const archive = path.join(outputDirectory, filename);
  await rm(archive, { force: true });
  // Keep every path argument relative because Windows tar interprets a
  // drive-letter prefix such as "F:\..." as a remote host ("Cannot connect to
  // F: resolve failed") when it is passed via -f or -C.
  const relativeArchive = path.relative(staging, archive).split(path.sep).join("/");
  const result = spawnSync("tar", ["-czf", relativeArchive, "."], {
    cwd: staging,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("tar failed to create the Worker runtime archive");
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${archive}.sha256`, `${sha256}  ${filename}\n`, { mode: 0o644 });
  console.log(
    JSON.stringify({
      archive,
      sha256,
      sizeBytes: bytes.byteLength,
      entry: "dist/worker-rpc-main.js",
    }),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
