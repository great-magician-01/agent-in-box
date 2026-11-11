import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "release");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const protocolSource = readFileSync(path.join(root, "packages/protocol/src/index.ts"), "utf8");
const protocolVersion = /PROTOCOL_VERSION = "([^"]+)"/.exec(protocolSource)?.[1] ?? "unknown";

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function collect() {
  const files = [];
  const add = (file) => {
    if (existsSync(file) && statSync(file).isFile()) files.push(file);
  };
  if (!existsSync(release)) return files;

  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.(exe|msi|AppImage|dmg|tar\.gz|zip)$/i.test(entry.name)) {
      add(path.join(release, entry.name));
    }
  }
  for (const directory of ["worker-runtime"]) {
    const target = path.join(release, directory);
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isFile() && /\.(tar\.gz|zip)$/i.test(entry.name)) {
        add(path.join(target, entry.name));
      }
    }
  }
  for (const directory of ["guest-agent"]) {
    const target = path.join(release, directory);
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isFile() && /^guest-agent-(linux|windows)-/.test(entry.name)) {
        add(path.join(target, entry.name));
      }
    }
  }
  add(path.join(release, "control-plane", "bundle.json"));
  return files.sort();
}

const files = collect();
const artifacts = [];
const sums = [];
for (const file of files) {
  const relative = path.relative(release, file).split(path.sep).join("/");
  const sha256 = await hashFile(file);
  const sizeBytes = statSync(file).size;
  artifacts.push({ path: relative, sizeBytes, sha256 });
  sums.push(`${sha256}  ${relative}`);

  const sidecar = `${file}.sha256`;
  if (existsSync(sidecar)) {
    const recorded = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
    if (recorded !== sha256) {
      console.error(`checksum mismatch for ${relative}: sidecar=${recorded} actual=${sha256}`);
      process.exit(1);
    }
  }
}

const generatedAt = new Date().toISOString();
writeFileSync(path.join(release, "SHA256SUMS"), `${sums.join("\n")}${sums.length ? "\n" : ""}`);
writeFileSync(
  path.join(release, "build-manifest.json"),
  `${JSON.stringify(
    {
      generatedAt,
      product: {
        name: "Agent-in-Box",
        version: packageJson.version,
        protocolVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      artifacts,
      note: "SHA-256 checksums only. Release signing uses an external certificate and is not performed by this script.",
    },
    null,
    2,
  )}\n`,
);

console.log(
  JSON.stringify({
    generatedAt,
    release,
    artifacts: artifacts.length,
    checksums: path.join(release, "SHA256SUMS"),
    manifest: path.join(release, "build-manifest.json"),
  }),
);
