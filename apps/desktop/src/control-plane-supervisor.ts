import { spawn, type ChildProcess } from "node:child_process";
import type { ControlPlaneState, ControlPlaneStatus, HealthResponse } from "@agent-in-box/protocol";
import type { LoggerLike } from "./logger";

export interface ControlPlaneSupervisorOptions {
  entryPath: string;
  workingDirectory: string;
  port: number;
  host?: string;
  nodeCommand: string;
  nodeArgs?: string[];
  runAsNode?: boolean;
  env?: NodeJS.ProcessEnv;
  logger: LoggerLike;
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  restartLimit?: number;
  restartWindowMs?: number;
  stopTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  fetchHealth?: (url: string, timeoutMs: number) => Promise<HealthResponse | null>;
  now?: () => number;
}

interface SupervisorInternalState {
  state: ControlPlaneState;
  health: HealthResponse | null;
  message: string | null;
  lastExitCode: number | null;
}

type StatusListener = (status: ControlPlaneStatus) => void;

export async function fetchControlPlaneHealth(
  url: string,
  timeoutMs: number,
): Promise<HealthResponse | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Partial<HealthResponse>;
    if (
      body.status === "ok" &&
      body.service === "control-plane" &&
      typeof body.protocolVersion === "string"
    ) {
      return body as HealthResponse;
    }
    return null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ControlPlaneSupervisor {
  private readonly options: Required<
    Pick<
      ControlPlaneSupervisorOptions,
      | "port"
      | "host"
      | "healthTimeoutMs"
      | "startupTimeoutMs"
      | "restartLimit"
      | "restartWindowMs"
      | "stopTimeoutMs"
    >
  > &
    ControlPlaneSupervisorOptions;

  private internal: SupervisorInternalState = {
    state: "stopped",
    health: null,
    message: null,
    lastExitCode: null,
  };
  private child: ChildProcess | null = null;
  private childExited = true;
  private expectedStop = false;
  private suppressRestart = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartTimestamps: number[] = [];
  private recentErrorLines: string[] = [];
  private readonly listeners = new Set<StatusListener>();
  private readonly logger: LoggerLike;
  private readonly now: () => number;

  constructor(options: ControlPlaneSupervisorOptions) {
    this.options = {
      host: "127.0.0.1",
      healthTimeoutMs: 1500,
      startupTimeoutMs: 15_000,
      restartLimit: 3,
      restartWindowMs: 60_000,
      stopTimeoutMs: 5000,
      ...options,
    };
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  getStatus(): ControlPlaneStatus {
    return {
      state: this.internal.state,
      pid: this.child?.pid ?? null,
      port: this.options.port,
      health: this.internal.health,
      message: this.internal.message,
      lastExitCode: this.internal.lastExitCode,
      restarts: this.restartTimestamps.length,
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.internal.state === "running" || this.internal.state === "external") {
      return;
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    this.restartTimestamps = [];
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.expectedStop = true;
    const child = this.child;

    if (!child || this.childExited) {
      this.child = null;
      this.setState("stopped", { health: null, message: "本地控制平面已停止" });
      return;
    }

    this.setState("stopping", {
      message: "正在停止本地控制平面",
    });

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
    const timer = delay(this.options.stopTimeoutMs).then(() => "timeout" as const);
    const result = await Promise.race([exited.then(() => "exited" as const), timer]);
    if (result === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, delay(2000)]);
    }

    this.child = null;
    this.internal.lastExitCode = child.exitCode;
    this.setState("stopped", { health: null, message: "本地控制平面已停止" });
  }

  private async doStart(): Promise<void> {
    this.clearRestartTimer();
    this.expectedStop = false;
    this.suppressRestart = false;

    const existing = await this.checkHealth();
    if (existing) {
      this.setState("external", {
        health: existing,
        message: "已连接正在运行的本地控制平面（外部进程）",
      });
      return;
    }

    this.setState("starting", {
      health: null,
      message: "正在启动本地控制平面",
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      CONTROL_PLANE_HOST: this.options.host,
      CONTROL_PLANE_PORT: String(this.options.port),
    };
    if (this.options.runAsNode) {
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }

    const spawnProcess = this.options.spawnProcess ?? spawn;
    try {
      this.child = spawnProcess(
        this.options.nodeCommand,
        [...(this.options.nodeArgs ?? []), this.options.entryPath],
        {
          cwd: this.options.workingDirectory,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      this.fail(`无法启动本地控制平面：${this.errorMessage(error)}`);
      throw error;
    }

    this.childExited = false;
    this.recentErrorLines = [];
    this.attachOutput(this.child);

    this.child.once("exit", (code, signal) => {
      this.childExited = true;
      this.internal.lastExitCode = code;
      if (this.expectedStop) {
        this.setState("stopped", { health: null, message: "本地控制平面已停止" });
        return;
      }
      if (this.suppressRestart) {
        return;
      }
      const detail = this.recentErrorLines.slice(-3).join(" | ");
      this.logger.error("本地控制平面异常退出", { code, signal, detail });
      this.fail(
        `本地控制平面异常退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）${
          detail ? `：${detail}` : ""
        }`,
      );
      this.scheduleRestart();
    });

    this.child.once("error", (error) => {
      this.fail(`本地控制平面进程错误：${error.message}`);
    });

    const healthy = await this.waitForHealth();
    if (!healthy) {
      if (!this.expectedStop && this.internal.state === "starting") {
        const detail = this.recentErrorLines.slice(-3).join(" | ");
        this.fail(
          `本地控制平面未在 ${this.options.startupTimeoutMs / 1000} 秒内就绪${
            detail ? `：${detail}` : ""
          }`,
        );
        this.suppressRestart = true;
        if (!this.childExited && this.child) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      throw new Error(this.internal.message ?? "本地控制平面启动失败");
    }

    this.setState("running", {
      health: healthy,
      message: null,
    });
    this.logger.info("本地控制平面已就绪", {
      pid: this.child.pid ?? null,
      port: this.options.port,
      protocolVersion: healthy.protocolVersion,
    });
  }

  private attachOutput(child: ChildProcess): void {
    const log = this.options.logger;
    const attach = (stream: NodeJS.ReadableStream | null, level: "info" | "warn"): void => {
      if (!stream) {
        return;
      }
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trimEnd();
          buffer = buffer.slice(index + 1);
          if (line.trim() !== "") {
            if (level === "warn") {
              this.recentErrorLines.push(line.slice(0, 500));
              if (this.recentErrorLines.length > 20) {
                this.recentErrorLines.shift();
              }
              log.warn(`[control-plane] ${line}`);
            } else {
              log.info(`[control-plane] ${line}`);
            }
          }
          index = buffer.indexOf("\n");
        }
        if (buffer.length > 16_384) {
          buffer = buffer.slice(-4096);
        }
      });
    };
    attach(child.stdout, "info");
    attach(child.stderr, "warn");
  }

  private async waitForHealth(): Promise<HealthResponse | null> {
    const deadline = this.now() + this.options.startupTimeoutMs;
    while (this.now() < deadline) {
      if (this.childExited) {
        return null;
      }
      const health = await this.checkHealth();
      if (health) {
        return health;
      }
      await delay(250);
    }
    return null;
  }

  private async checkHealth(): Promise<HealthResponse | null> {
    const healthUrl = `http://${this.options.host}:${this.options.port}/api/v1/health`;
    const fetchHealth = this.options.fetchHealth ?? fetchControlPlaneHealth;
    return fetchHealth(healthUrl, this.options.healthTimeoutMs);
  }

  private scheduleRestart(): void {
    const now = this.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp < this.options.restartWindowMs,
    );
    this.restartTimestamps.push(now);

    if (this.restartTimestamps.length > this.options.restartLimit) {
      this.internal.message = "本地控制平面连续异常退出，已停止自动重启。请查看日志后手动重启。";
      this.emit();
      return;
    }

    const attempt = this.restartTimestamps.length;
    this.logger.warn("将在后台自动重启本地控制平面", { attempt });
    this.restartTimer = setTimeout(() => {
      void this.start().catch((error: unknown) => {
        this.logger.error("自动重启本地控制平面失败", { error: this.errorMessage(error) });
      });
    }, 500 * attempt);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private fail(message: string): void {
    this.setState("failed", { health: null, message });
  }

  private setState(
    state: ControlPlaneState,
    patch: Partial<Omit<SupervisorInternalState, "state">>,
  ): void {
    this.internal = { ...this.internal, ...patch, state };
    this.emit();
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn("控制平面状态监听器异常", { error: this.errorMessage(error) });
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
