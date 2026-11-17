import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/agent-runtime/package.json",
  "packages/bot-connector/package.json",
  "packages/computer-use/package.json",
  "packages/config/package.json",
  "packages/domain/package.json",
  "packages/plugin-runtime/package.json",
  "packages/protocol/package.json",
  "packages/ui/package.json",
  "services/control-plane/package.json",
];

const tag = process.argv[2];
if (
  !tag ||
  !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    tag,
  )
) {
  throw new Error(
    `Release ref must be a semantic version tag such as v0.1.0; received ${tag ?? "nothing"}`,
  );
}
const version = tag.slice(1);
const failures = [];
for (const file of packageFiles) {
  const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  if (manifest.version !== version) failures.push(`${file}: ${manifest.version} !== ${version}`);
}

const releaseConfig = JSON.parse(
  readFileSync(path.join(root, "release-please-config.json"), "utf8"),
);
const extraFiles = new Set(
  (releaseConfig.packages["."]["extra-files"] ?? []).map((entry) => entry.path),
);
for (const file of packageFiles.slice(1)) {
  if (!extraFiles.has(file)) failures.push(`release-please-config.json does not update ${file}`);
}

if (failures.length > 0) {
  throw new Error(`Release version validation failed:\n${failures.join("\n")}`);
}
console.log(`Validated ${tag} across ${packageFiles.length} product package manifests`);
