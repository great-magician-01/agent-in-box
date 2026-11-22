import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopVmRuntimeState, VmRuntimeStatus } from "@agent-in-box/protocol";
import type { LoggerLike } from "./logger";
import type { ServiceShutdownHandler } from "./service-shutdown";
import { terminateChild } from "./process-stop";

export interface VmSupervisorOptions {
  entryPath: string;
  workingDirectory: string;
  storageRoot: string;
  qemuBinDirectory: string;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  logger: LoggerLike;
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  restartLimit?: number;
  restartWindowMs?: number;
  stopTimeoutMs?: number;
  /** How long an adopted supervisor may take to disappear after accepting shutdown. */
  shutdownConfirmMs?: number;
  spawnProcess?: typeof spawn;
  fetchHealth?: (url: string, timeoutMs: number) => Promise<VmSupervisorHealth | null>;
  now?: () => number;
  /** Installation nonce the spawned supervisor echoes from /healthz. */
  instanceNonce?: string;
  /**
   * Authenticated stop for a supervisor this shell did not spawn. Without it,
   * stop() fails instead of reporting an adopted process as stopped.
   */
  shutdown?: ServiceShutdownHandler;
}

export interface VmSupervisorHealth {
  ok: boolean;
  instanceNonce: string | null;
}

interface InternalState {
  state: DesktopVmRuntimeState;
  pid: number | null;
  message: string | null;
  lastError: string | null;
}

type StatusListener = (status: VmRuntimeStatus) => void;

async function fetchVmSupervisorHealth(
  url: string,
  timeoutMs: number,
): Promise<VmSupervisorHealth | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      status?: unknown;
      service?: unknown;
      instanceNonce?: unknown;
    };
    if (body.status !== "ok" || body.service !== "vm-supervisor") return null;
    return {
      ok: true,
      instanceNonce: typeof body.instanceNonce === "string" ? body.instanceNonce : null,
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VmSupervisor {
  private readonly options: Required<
    Pick<
      VmSupervisorOptions,
      | "port"
      | "host"
      | "healthTimeoutMs"
      | "startupTimeoutMs"
      | "restartLimit"
      | "restartWindowMs"
      | "stopTimeoutMs"
      | "shutdownConfirmMs"
    >
  > &
    VmSupervisorOptions;
  private internal: InternalState = {
    state: "stopped",
    pid: null,
    message: "VM 运行组件尚未启动",
    lastError: null,
  };
  private child: ChildProcess | null = null;
  private childExited = true;
  private childError: Error | null = null;
  private expectedStop = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartTimestamps: number[] = [];
  private readonly listeners = new Set<StatusListener>();
  private readonly logger: LoggerLike;
  private readonly now: () => number;
  private readonly instanceNonce: string;
  private qemuStatus: VmRuntimeStatus["qemu"] = {
    state: "missing",
    path: null,
    version: null,
    message: null,
    managedRoot: null,
  };
  private qemuBinDirectory: string;

  constructor(options: VmSupervisorOptions) {
    this.options = {
      port: 7610,
      host: "127.0.0.1",
      healthTimeoutMs: 1500,
      startupTimeoutMs: 15_000,
      restartLimit: 3,
      restartWindowMs: 60_000,
      stopTimeoutMs: 5000,
      shutdownConfirmMs: 10_000,
      ...options,
    };
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.qemuBinDirectory = options.qemuBinDirectory;
    this.instanceNonce = options.instanceNonce ?? "";
  }

  setStorageRoot(storageRoot: string): void {
    this.options.storageRoot = storageRoot;
  }

  setQemuStatus(qemu: VmRuntimeStatus["qemu"], binDirectory?: string | null): void {
    this.qemuStatus = qemu;
    if (binDirectory) this.qemuBinDirectory = binDirectory;
    this.emit();
  }

  getStatus(): VmRuntimeStatus {
    return {
      state: this.internal.state,
      pid: this.internal.pid,
      message: this.internal.message,
      lastError: this.internal.lastError,
      qemu: this.qemuStatus,
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.internal.state === "running" || this.internal.state === "starting") return;
    if (this.qemuStatus.state === "missing" || this.qemuStatus.state === "invalid") {
      this.setState("unavailable", {
        message: "QEMU 尚未安装或路径无效；请先安装/选择 QEMU",
      });
      return;
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    this.restartTimestamps = [];
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.expectedStop = true;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    const child = this.child;
    if (!child || this.childExited) {
      if (this.internal.state === "running" && !child) {
        await this.stopAdoptedInstance();
        return;
      }
      this.child = null;
      this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
      return;
    }
    this.setState("stopped", { message: "正在停止 VM 运行组件" });
    const exited = await terminateChild(child, {
      gracefulMs: this.options.stopTimeoutMs,
      forceMs: 2000,
      detachedGroup: !this.options.spawnProcess,
    });
    if (!exited) {
      this.setState("error", {
        pid: child.pid ?? null,
        message: "VM 运行组件未能在停止期限内退出",
        lastError: "stop timeout",
      });
      throw new Error("VM 运行组件未能在停止期限内退出");
    }
    this.child = null;
    this.childExited = true;
    this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
  }

  private async stopAdoptedInstance(): Promise<void> {
    const shutdown = this.options.shutdown;
    if (!shutdown) {
      this.setState("error", {
        message: "VM 运行组件由其他进程运行，当前未配置认证停止通道",
        lastError: "shutdown channel unavailable",
      });
      throw new Error("VM 运行组件由其他进程运行，无法安全停止");
    }
    this.setState("running", { message: "正在停止外部 VM 运行组件" });
    try {
      await shutdown({
        baseUrl: `http://${this.options.host}:${this.options.port}`,
        instanceNonce: this.instanceNonce,
        timeoutMs: this.options.stopTimeoutMs,
      });
    } catch (error) {
      this.setState("error", {
        message: "外部 VM 运行组件停止失败",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const probe = this.options.fetchHealth ?? fetchVmSupervisorHealth;
    const healthUrl = `http://${this.options.host}:${this.options.port}/healthz`;
    const deadline = this.now() + this.options.stopTimeoutMs + this.options.shutdownConfirmMs;
    while (this.now() < deadline) {
      const health = await probe(healthUrl, this.options.healthTimeoutMs);
      if (!health) {
        this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
        return;
      }
      await delay(200);
    }
    this.setState("error", {
      message: "外部 VM 运行组件接受了停止请求，但仍在响应",
      lastError: "shutdown not effective",
    });
    throw new Error("外部 VM 运行组件仍在运行");
  }

  private isOurs(health: VmSupervisorHealth): boolean {
    if (!this.instanceNonce) return health.ok;
    return health.ok && health.instanceNonce === this.instanceNonce;
  }

  private async doStart(): Promise<void> {
    this.clearRestartTimer();
    this.expectedStop = false;
    const healthUrl = `http://${this.options.host}:${this.options.port}/healthz`;
    const probe = this.options.fetchHealth ?? fetchVmSupervisorHealth;
    const existing = await probe(healthUrl, this.options.healthTimeoutMs);
    if (existing) {
      if (!this.isOurs(existing)) {
        this.setState("error", {
          pid: null,
          message: "VM Supervisor 端口已被其他进程占用，已拒绝连接",
          lastError: "instance identity mismatch",
        });
        return;
      }
      this.setState("running", {
        pid: null,
        message: "已连接正在运行的 VM Supervisor（本安装实例）",
      });
      return;
    }
    this.setState("starting", { message: "正在启动 VM Supervisor" });
    const qemuSystem =
      process.platform === "win32" ? "qemu-system-x86_64.exe" : "qemu-system-x86_64";
    const qemuImg = process.platform === "win32" ? "qemu-img.exe" : "qemu-img";
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    const command = this.options.spawnProcess ?? spawn;
    const detached = !this.options.spawnProcess && process.platform !== "win32";
    const child = command(
      this.options.entryPath,
      [
        "-addr",
        `${this.options.host}:${this.options.port}`,
        "-storage-root",
        this.options.storageRoot,
        ...(this.instanceNonce ? ["-instance-nonce", this.instanceNonce] : []),
        "-qemu-system",
        joinPath(this.qemuBinDirectory, qemuSystem),
        "-qemu-img",
        joinPath(this.qemuBinDirectory, qemuImg),
      ],
      {
        cwd: this.options.workingDirectory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(detached ? { detached: true } : {}),
      },
    );
    this.child = child;
    this.childExited = false;
    this.childError = null;
    child.stdout?.on("data", (data: Buffer) => {
      this.logger.info(`vm-supervisor: ${data.toString("utf8").trimEnd()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.logger.warn(`vm-supervisor: ${data.toString("utf8").trimEnd()}`);
    });
    child.once("error", (error) => {
      // Asynchronous spawn failure (ENOENT, EACCES): no pid was assigned, so the
      // handle must not survive as if a supervisor were running.
      this.childError = error;
      this.childExited = true;
      if (this.child === child) {
        this.child = null;
      }
      this.setState("error", {
        pid: null,
        lastError: error.message,
        message: "VM Supervisor 启动失败",
      });
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      this.childExited = true;
      if (this.expectedStop) {
        this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
        return;
      }
      const reason = `VM Supervisor 异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`;
      this.setState("error", { pid: null, message: reason, lastError: reason });
      this.scheduleRestart();
    });

    const deadline = this.now() + this.options.startupTimeoutMs;
    while (this.now() < deadline) {
      const spawnError = this.lastSpawnError();
      if (spawnError) {
        throw new Error(`VM Supervisor 启动失败：${spawnError.message}`);
      }
      if (child.exitCode !== null || this.childExited) {
        throw new Error(`VM Supervisor 启动后立即退出（code=${child.exitCode}）`);
      }
      const health = await probe(healthUrl, this.options.healthTimeoutMs);
      if (health && this.isOurs(health)) {
        this.setState("running", {
          pid: child.pid ?? null,
          message: "VM Supervisor 在线",
          lastError: null,
        });
        return;
      }
      await delay(250);
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    throw new Error("VM Supervisor 启动超时");
  }

  private scheduleRestart(): void {
    const now = this.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp < this.options.restartWindowMs,
    );
    if (this.restartTimestamps.length >= this.options.restartLimit) {
      this.setState("error", {
        message: "VM Supervisor 连续异常退出，已停止自动重启",
      });
      return;
    }
    this.restartTimestamps.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error: unknown) => {
        this.logger.error("VM Supervisor 自动重启失败", { error: String(error) });
      });
    }, 1500);
    this.restartTimer.unref();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private setState(
    state: DesktopVmRuntimeState,
    patch: Partial<Omit<InternalState, "state">> = {},
  ): void {
    this.internal = {
      state,
      pid: patch.pid === undefined ? this.internal.pid : patch.pid,
      message: patch.message === undefined ? this.internal.message : patch.message,
      lastError: patch.lastError === undefined ? this.internal.lastError : patch.lastError,
    };
    this.emit();
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }

  private lastSpawnError(): Error | null {
    return this.childError;
  }
}

function joinPath(directory: string, file: string): string {
  return `${directory.replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}${file}`;
}
