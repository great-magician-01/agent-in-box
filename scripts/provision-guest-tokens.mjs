import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error(
    [
      "Usage: node scripts/provision-guest-tokens.mjs --vm-storage <dir> [--token-dir <dir>] [--force]",
      "",
      "Writes guest-agent.token and worker-rpc.token to the VM storage directory",
      "(0600). With --token-dir, also writes copies for a controlled provisioning",
      "medium. Existing token files are never overwritten unless --force is set.",
      "Token values are not printed.",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
let vmStorage = "";
let tokenDir = "";
let force = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--vm-storage") {
    vmStorage = args[++index] ?? "";
  } else if (arg === "--token-dir") {
    tokenDir = args[++index] ?? "";
  } else if (arg === "--force") {
    force = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}
if (!vmStorage || !path.isAbsolute(vmStorage)) {
  usage();
  process.exit(2);
}

const names = ["guest-agent.token", "worker-rpc.token"];
for (const name of names) {
  const existing = await lstat(path.join(vmStorage, name)).catch(() => null);
  if (existing && !force) {
    console.error(`${path.join(vmStorage, name)} already exists; use --force to rotate it`);
    process.exit(1);
  }
}

await mkdir(vmStorage, { recursive: true, mode: 0o700 });
if (tokenDir) await mkdir(tokenDir, { recursive: true, mode: 0o700 });

for (const name of names) {
  const token = randomBytes(32).toString("base64url");
  for (const directory of tokenDir ? [vmStorage, tokenDir] : [vmStorage]) {
    const destination = path.join(directory, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, token, { mode: 0o600, flag: "w" });
    await rename(temporary, destination);
    const stored = await readFile(destination, "utf8");
    if (stored !== token) throw new Error(`token write verification failed: ${destination}`);
  }
}

console.log(
  JSON.stringify({
    vmStorage,
    tokenDir: tokenDir || null,
    files: names,
    note: "Token values were not printed. Copy them to the Guest through a controlled provisioning medium.",
  }),
);
