import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerLike {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface JsonLineLoggerOptions {
  directory: string;
  scope?: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => Date;
  mirrorToConsole?: boolean;
}

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|credential)/i;
const MAX_STRING_LENGTH = 2000;

/**
 * Control-plane output is captured line-by-line and written as the log
 * message. Scrub credential shapes there too, not just in structured data.
 */
export function redactText(raw: string): string {
  const redacted = raw
    .replace(/\baib_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer|QQBot)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /((?:"|')?(?:api[_-]?key|app[_-]?secret|secret|token|authorization|password|passwd|credential|cookie|access[_-]?key)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(aib_session=)[^;\s]+/gi, "$1[REDACTED]");
  return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…` : redacted;
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSensitive(entry, depth + 1);
    }
    return output;
  }
  return value;
}

export class JsonLineLogger implements LoggerLike {
  readonly directory: string;
  readonly filePath: string;
  private readonly scope: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private readonly mirrorToConsole: boolean;

  constructor(options: JsonLineLoggerOptions) {
    this.directory = options.directory;
    this.filePath = path.join(options.directory, "desktop.log");
    this.scope = options.scope ?? "desktop";
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.now = options.now ?? (() => new Date());
    this.mirrorToConsole = options.mirrorToConsole ?? false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  child(scope: string): JsonLineLogger {
    return new JsonLineLogger({
      directory: this.directory,
      scope: `${this.scope}:${scope}`,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      now: this.now,
      mirrorToConsole: this.mirrorToConsole,
    });
  }

  debug(message: string, data?: unknown): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const record = {
      time: this.now().toISOString(),
      level,
      scope: this.scope,
      message: redactText(message),
      ...(data !== undefined ? { data: redactSensitive(data) } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.filePath, line, { mode: 0o600 });
    } catch {
      // Logging must never take down the desktop process.
    }
    if (this.mirrorToConsole) {
      const writer =
        level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      writer(`[${this.scope}] ${message}`, data ?? "");
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const size = statSync(this.filePath).size;
    if (size + incomingBytes <= this.maxBytes) {
      return;
    }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      const destination = `${this.filePath}.${index + 1}`;
      if (existsSync(source)) {
        if (index === this.maxFiles - 1) {
          rmSync(destination, { force: true });
        }
        renameSync(source, destination);
      }
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}
