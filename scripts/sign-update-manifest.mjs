import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

function usage() {
  console.error(
    "usage: node scripts/sign-update-manifest.mjs <manifest.json> <ed25519-private-key.pem> <output.json>",
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
  throw new Error("manifest must be a JSON object");
}
const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("private key must be Ed25519");
}
// Purpose-scoped payload: the desktop verifier signs the domain string, a
// newline, and the canonical JSON of the manifest.
const DOMAIN = "agent-in-box/desktop-update/v1";
const signature = sign(
  null,
  Buffer.from(
    `${DOMAIN}
${canonicalJson(manifest)}`,
    "utf8",
  ),
  privateKey,
).toString("base64");
writeFileSync(outputPath, `${JSON.stringify({ manifest, signature }, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    output: outputPath,
    domain: DOMAIN,
    publicKey: privateKey.asymmetricKeyType,
    signatureBytes: Buffer.from(signature, "base64").length,
  }),
);
