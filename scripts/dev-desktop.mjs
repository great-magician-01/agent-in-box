import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(pnpm, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["build:packages"]);
run(["--filter", "@agent-in-box/web", "build"]);
run(["--filter", "@agent-in-box/control-plane", "build"]);
run(["--filter", "@agent-in-box/desktop", "build"]);

const child = spawn(pnpm, ["--filter", "@agent-in-box/desktop", "start"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    AGENT_IN_BOX_WEB_ROOT: path.join(root, "apps", "web", "dist"),
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
