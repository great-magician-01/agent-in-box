import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface TerminateOptions {
  /** How long SIGTERM may take before escalation. */
  gracefulMs: number;
  /** How long SIGKILL may take before the stop is declared failed. */
  forceMs: number;
  /**
   * True only for children this process spawned with detach semantics. It is
   * false when a caller injects a spawn implementation, so tests and embedders
   * never cause a signal to be sent to an unrelated process group.
   */
  detachedGroup: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, detachedGroup: boolean): void {
  if (detachedGroup && child.pid && process.platform !== "win32") {
    try {
      // Negative PID targets the process group created by detached: true, so
      // wrapper scripts do not leave QEMU or Node grandchildren behind.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct handle; the group may already be gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

/**
 * Terminates a child and confirms it is gone. Returns true only when the
 * process (and, for self-spawned POSIX children, its group) has exited.
 * Reporting success without that confirmation is what lets a dying process keep
 * owning the SQLite database or overlay disk while the UI says "stopped".
 */
export async function terminateChild(
  child: ChildProcess,
  options: TerminateOptions,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  signalChild(child, "SIGTERM", options.detachedGroup);
  if (await raceTimeout(exited, options.gracefulMs)) return true;

  signalChild(child, "SIGKILL", options.detachedGroup);
  if (await raceTimeout(exited, options.forceMs)) return true;

  if (process.platform === "win32" && child.pid) {
    await taskkillTree(child.pid);
    if (await raceTimeout(exited, options.forceMs)) return true;
  }
  // Give a detached POSIX group a final moment before declaring failure.
  await delay(50);
  return child.exitCode !== null;
}
