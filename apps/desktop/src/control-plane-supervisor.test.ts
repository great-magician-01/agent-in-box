import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@agent-in-box/protocol";
import { ControlPlaneSupervisor } from "./control-plane-supervisor";

class FakeChildProcess extends EventEmitter {
  pid = 777;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.exitCode = 0;
    this.emit("exit", 0, signal ?? null);
    return true;
  }
}

const instanceNonce = "test-instance-nonce-0123456789abcdef";

const health: HealthResponse = {
  status: "ok",
  service: "control-plane",
  protocolVersion: "0.1.0",
  startedAt: "2026-11-10T00:00:00.000Z",
  now: "2026-11-10T00:00:00.000Z",
  instanceNonce,
};

function logger(): {
  messages: Array<{ level: string; message: string }>;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
} {
  const messages: Array<{ level: string; message: string }> = [];
  return {
    messages,
    debug: (message) => messages.push({ level: "debug", message }),
    info: (message) => messages.push({ level: "info", message }),
    warn: (message) => messages.push({ level: "warn", message }),
    error: (message) => messages.push({ level: "error", message }),
  };
}

describe("control plane supervisor", () => {
  it("attaches to an already running local control plane", async () => {
    let spawned = false;
    const supervisor = new ControlPlaneSupervisor({
      entryPath: "/service/main.js",
      workingDirectory: "/service",
      port: 3000,
      nodeCommand: "node",
      instanceNonce,
      logger: logger(),
      fetchHealth: async () => health,
      spawnProcess: (() => {
        spawned = true;
        return new FakeChildProcess();
      }) as unknown as typeof spawn,
    });

    await supervisor.start();

    expect(spawned).toBe(false);
    expect(supervisor.getStatus()).toMatchObject({
      state: "external",
      health,
      pid: null,
    });
  });

  it("refuses to attach to a process that cannot prove the installation nonce", async () => {
    let spawned = false;
    const supervisor = new ControlPlaneSupervisor({
      entryPath: "/service/main.js",
      workingDirectory: "/service",
      port: 3000,
      nodeCommand: "node",
      instanceNonce,
      logger: logger(),
      fetchHealth: async () => ({ ...health, instanceNonce: "someone-else" }),
      spawnProcess: (() => {
        spawned = true;
        return new FakeChildProcess();
      }) as unknown as typeof spawn,
    });

    await supervisor.start();

    expect(spawned).toBe(false);
    expect(supervisor.getStatus().state).toBe("failed");
  });

  it("starts a child process, waits for health and stops it", async () => {
    const child = new FakeChildProcess();
    let calls = 0;
    let captured:
      { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string } | undefined;
    const supervisor = new ControlPlaneSupervisor({
      entryPath: "/service/main.js",
      workingDirectory: "/service",
      port: 3123,
      nodeCommand: "/electron",
      runAsNode: true,
      instanceNonce,
      env: { AGENT_IN_BOX_CONFIG_DIR: "/config" },
      logger: logger(),
      fetchHealth: async () => {
        calls += 1;
        return calls >= 2 ? health : null;
      },
      spawnProcess: ((
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv; cwd?: string },
      ) => {
        captured = { command, args, env: options.env, cwd: options.cwd };
        return child;
      }) as unknown as typeof spawn,
      stopTimeoutMs: 1000,
    });

    const states: string[] = [];
    supervisor.onStatus((status) => states.push(status.state));

    await supervisor.start();

    expect(supervisor.getStatus()).toMatchObject({ state: "running", pid: 777 });
    expect(states).toContain("starting");
    expect(states).toContain("running");
    expect(captured?.command).toBe("/electron");
    expect(captured?.args).toEqual(["/service/main.js"]);
    expect(captured?.env).toMatchObject({
      AGENT_IN_BOX_CONFIG_DIR: "/config",
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: "3123",
      AGENT_IN_BOX_INSTANCE_NONCE: instanceNonce,
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(captured?.cwd).toBe("/service");

    await supervisor.stop();

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(supervisor.getStatus().state).toBe("stopped");
  });

  it("fails explicitly when the service never becomes healthy", async () => {
    const child = new FakeChildProcess();
    const supervisor = new ControlPlaneSupervisor({
      entryPath: "/service/main.js",
      workingDirectory: "/service",
      port: 3000,
      nodeCommand: "node",
      instanceNonce,
      logger: logger(),
      fetchHealth: async () => null,
      spawnProcess: (() => child) as unknown as typeof spawn,
      startupTimeoutMs: 50,
      stopTimeoutMs: 100,
    });

    await expect(supervisor.start()).rejects.toThrow("未在");
    expect(supervisor.getStatus().state).toBe("failed");
    expect(child.signals).toContain("SIGKILL");
  });

  it("restarts the process on demand", async () => {
    const children: FakeChildProcess[] = [];
    let calls = 0;
    const supervisor = new ControlPlaneSupervisor({
      entryPath: "/service/main.js",
      workingDirectory: "/service",
      port: 3000,
      nodeCommand: "node",
      instanceNonce,
      logger: logger(),
      fetchHealth: async () => {
        calls += 1;
        // Each start does one pre-check and then one successful poll.
        return calls % 2 === 0 ? health : null;
      },
      spawnProcess: (() => {
        const child = new FakeChildProcess();
        children.push(child);
        return child;
      }) as unknown as typeof spawn,
      stopTimeoutMs: 1000,
    });

    await supervisor.start();
    expect(children).toHaveLength(1);

    await supervisor.restart();
    expect(children).toHaveLength(2);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(supervisor.getStatus().state).toBe("running");
  });
});
