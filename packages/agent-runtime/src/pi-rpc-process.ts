import { spawn, type ChildProcess } from "node:child_process";

export interface PiRpcProcessOptions {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Minimal Pi JSONL RPC process client. Records are split only on LF, because
 * U+2028/U+2029 are valid inside JSON strings and must not terminate a record.
 */
export class PiRpcProcess {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  private exitError: Error | null = null;

  constructor(private readonly options: PiRpcProcessOptions) {}

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("Pi RPC process already started");
    }
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;

    child.on("error", (error) => {
      this.exitError = error;
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      this.exitError = new Error(`Pi RPC exited with code=${code} signal=${signal ?? "none"}`);
      this.rejectAll(this.exitError);
      for (const listener of this.listeners) {
        listener({ type: "process_exit", code, signal });
      }
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        for (const listener of this.listeners) {
          listener({ type: "protocol_error", message: String(error) });
        }
        continue;
      }
      if (event.type === "response" && typeof event.id === "string") {
        const entry = this.pending.get(event.id);
        if (entry) {
          this.pending.delete(event.id);
          if (event.success === true) {
            entry.resolve(event.data);
          } else {
            entry.reject(new Error(typeof event.error === "string" ? event.error : "Pi command failed"));
          }
        }
        continue;
      }
      for (const listener of this.listeners) listener(event);
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  async command<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    const child = this.child;
    if (!child) throw new Error("Pi RPC process is not started");
    if (this.exitError) throw this.exitError;
    const stdin = child.stdin;
    if (!stdin) throw new Error("Pi RPC stdin is unavailable");
    const id = `req-${this.nextId++}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
      });
    });
    const record = JSON.stringify({ id, type, ...fields }) + "\n";
    await new Promise<void>((resolve, reject) => {
      stdin.write(record, (error) => (error ? reject(error) : resolve()));
    });
    return promise;
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    const stdin = child.stdin;
    if (stdin) stdin.end();
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, 5000);
    await exited;
    clearTimeout(timeout);
    this.child = null;
  }
}
