import path from "node:path";
import {
  PI_ENGINE_VERSION,
  PI_SESSION_FORMAT_VERSION,
  PiWorkerEngine,
  WorkerRpcServer,
  resolvePiLaunch,
} from "./index";

async function main(): Promise<void> {
  const tokenFile = required("AGENT_IN_BOX_WORKER_TOKEN_FILE");
  const sessionRoot = path.resolve(required("AGENT_IN_BOX_SESSION_ROOT"));
  const extensionPath = process.env.AGENT_IN_BOX_CUA_EXTENSION?.trim();
  const subagentExtensionPath = path.join(__dirname, "..", "extensions", "subagent-extension.js");
  const developmentExtensionPath = path.join(
    __dirname,
    "..",
    "extensions",
    "plugin-development-extension.js",
  );
  const piLaunch = resolvePiLaunch();
  const engine = new PiWorkerEngine({
    sessionRoot,
    piBinary: piLaunch.command,
    argsPrefix: piLaunch.argsPrefix,
    subagentExtensionPath,
    developmentExtensionPath,
    ...(extensionPath ? { extensionPaths: [extensionPath] } : {}),
    engineVersion: process.env.AGENT_IN_BOX_PI_VERSION?.trim() || PI_ENGINE_VERSION,
    sessionVersion: PI_SESSION_FORMAT_VERSION,
  });
  const server = new WorkerRpcServer({
    engine,
    tokenFile,
    host: process.env.AGENT_IN_BOX_WORKER_HOST?.trim() || "0.0.0.0",
    port: readPort(process.env.AGENT_IN_BOX_WORKER_PORT),
    engineVersion: process.env.AGENT_IN_BOX_PI_VERSION?.trim() || PI_ENGINE_VERSION,
    sessionVersion: PI_SESSION_FORMAT_VERSION,
  });
  const listening = await server.start();
  console.log(
    JSON.stringify({
      status: "listening",
      service: "agent-in-box-worker",
      host: listening.host,
      port: listening.port,
      engine: "pi-rpc",
      engineVersion: process.env.AGENT_IN_BOX_PI_VERSION?.trim() || PI_ENGINE_VERSION,
      sessionVersion: PI_SESSION_FORMAT_VERSION,
    }),
  );

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        console.error("Worker RPC shutdown failed", error);
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPort(raw: string | undefined): number {
  if (!raw?.trim()) return 7612;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid AGENT_IN_BOX_WORKER_PORT: ${raw}`);
  }
  return port;
}

main().catch((error: unknown) => {
  console.error("Worker RPC failed to start", error);
  process.exitCode = 1;
});
