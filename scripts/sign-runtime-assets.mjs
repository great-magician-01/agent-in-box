import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Signs runtime-assets.json. The signed bytes are purpose-scoped so a signature
 * produced for an update manifest can never be replayed as a runtime asset
 * manifest (and vice versa). Keep this format in sync with
 * apps/desktop/src/signature.ts.
 */
const DOMAIN = "agent-in-box/runtime-assets/v1";

function usage() {
  console.error(
    "usage: node scripts/sign-runtime-assets.mjs <runtime-assets.json> <ed25519-private-key.pem> <output.json>",
  );
  process.exit(2);
}

const [manifestPath, keyPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !keyPath || !outputPath) usage();

function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  throw new Error("runtime assets manifest must be a JSON object");
}
if (manifest.signature !== undefined) {
  throw new Error("refusing to sign a manifest that already carries a signature");
}
const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("private key must be Ed25519");
}
const signature = sign(
  null,
  Buffer.from(`${DOMAIN}\n${canonicalJson(manifest)}`, "utf8"),
  privateKey,
).toString("base64");
writeFileSync(outputPath, `${JSON.stringify({ ...manifest, signature }, null, 2)}\n`, {
  mode: 0o644,
});
console.log(
  JSON.stringify({
    output: outputPath,
    domain: DOMAIN,
    signatureBytes: Buffer.from(signature, "base64").length,
  }),
);
