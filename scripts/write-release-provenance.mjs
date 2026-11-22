import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Records the build context that produced release artifacts. Publishing refuses
 * to proceed when the recorded source commit is not the commit the release tag
 * points at, so a hand-picked artifact set from another run cannot be published
 * under this tag.
 */
const root = path.resolve(import.meta.dirname, "..");
const output = process.argv[2] ?? path.join(root, "release", "release-provenance.json");

const tag = (process.env.RELEASE_TAG ?? "").trim();
const sourceSha = (process.env.RELEASE_SOURCE_SHA ?? "").trim().toLowerCase();
const workflow = (process.env.RELEASE_WORKFLOW ?? "").trim() || "release-assets.yml";
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`RELEASE_TAG is not a semantic version tag: ${tag}`);
}
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error(`RELEASE_SOURCE_SHA must be a full 40-character commit SHA: ${sourceSha}`);
}
if (tag.replace(/^v/, "") !== packageVersion) {
  throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
}

const provenance = {
  schemaVersion: 1,
  tag,
  sourceSha,
  packageVersion,
  workflow,
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
};
writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ output, ...provenance }));
