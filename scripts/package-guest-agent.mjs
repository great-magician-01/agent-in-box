import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repository, "release", "guest-agent");
const version = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")).version;

const targets = [
  { goos: "linux", goarch: "amd64", fileName: "guest-agent-linux-amd64" },
  { goos: "windows", goarch: "amd64", fileName: "guest-agent-windows-amd64.exe" },
];

await mkdir(outputDirectory, { recursive: true });
const artifacts = [];
for (const target of targets) {
  const output = path.join(outputDirectory, target.fileName);
  await rm(output, { force: true });
  await rm(`${output}.sha256`, { force: true });
  const result = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      output,
      "./services/guest-agent/cmd/guest-agent",
    ],
    {
      cwd: repository,
      stdio: "inherit",
      env: {
        ...process.env,
        GOOS: target.goos,
        GOARCH: target.goarch,
        CGO_ENABLED: "0",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`go build failed for ${target.goos}/${target.goarch}`);
  }
  const bytes = await readFile(output);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${output}.sha256`, `${sha256}  ${target.fileName}\n`, { mode: 0o644 });
  artifacts.push({
    os: target.goos,
    architecture: target.goarch,
    file: path.relative(repository, output).split(path.sep).join("/"),
    sizeBytes: bytes.byteLength,
    sha256,
  });
}

const manifest = {
  version,
  builtAt: new Date().toISOString(),
  protocolVersion: /GUEST_PROTOCOL_VERSION = "([^"]+)"/.exec(
    await readFile(path.join(repository, "packages/protocol/src/index.ts"), "utf8"),
  )?.[1],
  artifacts,
  note: "Guest Agent binaries only. Token files, Provider keys and bot secrets are never packaged.",
};
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify({ outputDirectory, artifacts }));
