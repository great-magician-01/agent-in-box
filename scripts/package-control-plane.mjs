import {
  existsSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "release", "control-plane");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

rmSync(target, { recursive: true, force: true });

const deploy = spawnSync(
  pnpm,
  ["--filter", "@agent-in-box/control-plane", "deploy", "--prod", "--legacy", target],
  {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
    },
  },
);

if (deploy.status !== 0) {
  process.exit(deploy.status ?? 1);
}

// pnpm's legacy deploy can switch the workspace node_modules into production
// mode. Restore dev dependencies so later packaging/test steps still work.
const restore = spawnSync(pnpm, ["install", "--frozen-lockfile"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    CI: process.env.CI ?? "true",
  },
});
if (restore.status !== 0) {
  process.exit(restore.status ?? 1);
}

// electron-builder always excludes folders literally named node_modules from
// extraResources. Rename the pnpm deploy tree and expose it through NODE_PATH;
// the internal relative symlinks keep working because .pnpm moves with it.
const deployedModules = path.join(target, "node_modules");
const runtimeModules = path.join(target, "runtime_modules");
if (existsSync(deployedModules)) {
  renameSync(deployedModules, runtimeModules);
}

// pnpm 11 may emit absolute symlinks on Windows. Once node_modules is renamed,
// those links still point at the old directory. Rewrite only links into the
// deployed tree. POSIX uses relative links; Windows uses non-elevated junctions.
function repairDeployedSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const rawTarget = readlinkSync(entryPath);
      const absoluteTarget = path.resolve(directory, rawTarget);
      const marker = `${path.sep}node_modules${path.sep}`;
      const markerIndex = absoluteTarget.indexOf(marker);
      if (markerIndex < 0) continue;
      const repairedTarget =
        absoluteTarget.slice(0, markerIndex) +
        `${path.sep}runtime_modules${path.sep}` +
        absoluteTarget.slice(markerIndex + marker.length);
      rmSync(entryPath);
      if (process.platform === "win32") {
        symlinkSync(repairedTarget, entryPath, "junction");
      } else {
        symlinkSync(path.relative(directory, repairedTarget), entryPath, "dir");
      }
    } else if (entry.isDirectory()) {
      repairDeployedSymlinks(entryPath);
    }
  }
}

if (existsSync(runtimeModules)) {
  repairDeployedSymlinks(runtimeModules);
}

// pnpm adds a self-reference back into the workspace. It is broken once the
// bundle is copied into the installer and is not needed at runtime.
rmSync(path.join(runtimeModules, ".pnpm", "node_modules", "@agent-in-box", "control-plane"), {
  recursive: true,
  force: true,
});

for (const required of [
  "dist/main.js",
  "runtime_modules/better-sqlite3/package.json",
  "runtime_modules/ws/package.json",
  "runtime_modules/@agent-in-box/config/dist/index.js",
  "runtime_modules/@agent-in-box/protocol/dist/index.js",
]) {
  const file = path.join(target, required);
  if (!existsSync(file)) {
    console.error(`control-plane bundle is missing ${required}`);
    process.exit(1);
  }
}

for (const unnecessary of ["src", "tsconfig.json", "nest-cli.json"]) {
  rmSync(path.join(target, unnecessary), { recursive: true, force: true });
}

writeFileSync(
  path.join(target, "bundle.json"),
  `${JSON.stringify(
    {
      name: "@agent-in-box/control-plane",
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  )}\n`,
);

console.log(`control-plane bundle ready: ${target}`);
