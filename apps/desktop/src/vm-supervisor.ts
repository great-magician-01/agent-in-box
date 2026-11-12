import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopVmRuntimeState, VmRuntimeStatus } from "@agent-in-box/protocol";
import type { LoggerLike } from "./logger";

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
  spawnProcess?: typeof spawn;
  fetchHealth?: (url: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
}

interface InternalState {
  state: DesktopVmRuntimeState;
  pid: number | null;
  message: string | null;
  lastError: string | null;
}

type StatusListener = (status: VmRuntimeStatus) => void;

async function fetchVmSupervisorHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; service?: unknown };
    return body.status === "ok" && body.service === "vm-supervisor";
  } catch {
    return false;
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
  private expectedStop = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartTimestamps: number[] = [];
  private readonly listeners = new Set<StatusListener>();
  private readonly logger: LoggerLike;
  private readonly now: () => number;
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
      ...options,
    };
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.qemuBinDirectory = options.qemuBinDirectory;
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
    const child = this.child;
    if (!child) {
      this.child = null;
      this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
      return;
    }
    this.setState("stopped", { message: "正在停止 VM 运行组件" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const winner = await Promise.race([
      exited.then(() => "exited" as const),
      delay(this.options.stopTimeoutMs).then(() => "timeout" as const),
    ]);
    if (winner === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, delay(2000)]);
    }
    this.child = null;
    this.setState("stopped", { pid: null, message: "VM 运行组件已停止" });
  }

  private async doStart(): Promise<void> {
    this.clearRestartTimer();
    this.expectedStop = false;
    const healthUrl = `http://${this.options.host}:${this.options.port}/healthz`;
    const existing = await (this.options.fetchHealth ?? fetchVmSupervisorHealth)(
      healthUrl,
      this.options.healthTimeoutMs,
    );
    if (existing) {
      this.setState("running", {
        pid: null,
        message: "已连接正在运行的 VM Supervisor（外部进程）",
      });
      return;
    }
    this.setState("starting", { message: "正在启动 VM Supervisor" });
    const qemuSystem =
      process.platform === "win32" ? "qemu-system-x86_64.exe" : "qemu-system-x86_64";
    const qemuImg = process.platform === "win32" ? "qemu-img.exe" : "qemu-img";
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    const command = this.options.spawnProcess ?? spawn;
    const child = command(
      this.options.entryPath,
      [
        "-addr",
        `${this.options.host}:${this.options.port}`,
        "-storage-root",
        this.options.storageRoot,
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
      },
    );
    this.child = child;
    child.stdout?.on("data", (data: Buffer) => {
      this.logger.info(`vm-supervisor: ${data.toString("utf8").trimEnd()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.logger.warn(`vm-supervisor: ${data.toString("utf8").trimEnd()}`);
    });
    child.once("error", (error) => {
      this.setState("error", { lastError: error.message, message: "VM Supervisor 启动失败" });
    });
    child.once("exit", (code, signal) => {
      this.child = null;
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
      if (child.exitCode !== null) {
        throw new Error(`VM Supervisor 启动后立即退出（code=${child.exitCode}）`);
      }
      if (
        await (this.options.fetchHealth ?? fetchVmSupervisorHealth)(
          healthUrl,
          this.options.healthTimeoutMs,
        )
      ) {
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
}

function joinPath(directory: string, file: string): string {
  return `${directory.replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}${file}`;
}
