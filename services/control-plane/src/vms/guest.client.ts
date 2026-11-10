import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  GuestActionResult,
  GuestAgentCapabilities,
  GuestDesktopInfo,
  GuestHeartbeat,
  GuestInputAction,
  GuestScreenshot,
  GuestVersionHandshake,
} from "@agent-in-box/protocol";
import { GUEST_PROTOCOL_VERSION } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";

export const GUEST_CLIENT_OPTIONS = Symbol("AGENT_IN_BOX_GUEST_CLIENT_OPTIONS");

export interface GuestClientOptions {
  fetchImpl?: typeof fetch;
  tokenFile?: string;
  timeoutMs?: number;
}

export interface GuestTarget {
  hostPort: number;
  storageRoot: string;
}

@Injectable()
export class GuestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sharedTokenFile?: string;
  private readonly timeoutMs: number;

  constructor(@Optional() @Inject(GUEST_CLIENT_OPTIONS) options: GuestClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const tokenFile = options.tokenFile ?? process.env.AGENT_IN_BOX_GUEST_TOKEN_FILE?.trim();
    if (tokenFile) this.sharedTokenFile = tokenFile;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  heartbeat(target: GuestTarget): Promise<GuestHeartbeat> {
    return this.request(
      target,
      `/v1/heartbeat?protocolVersion=${encodeURIComponent(GUEST_PROTOCOL_VERSION)}`,
    );
  }

  version(target: GuestTarget): Promise<GuestVersionHandshake> {
    return this.request(
      target,
      `/v1/version?protocolVersion=${encodeURIComponent(GUEST_PROTOCOL_VERSION)}`,
    );
  }

  capabilities(target: GuestTarget): Promise<GuestAgentCapabilities> {
    return this.request(target, "/v1/capabilities");
  }

  desktop(target: GuestTarget): Promise<GuestDesktopInfo> {
    return this.request(target, "/v1/desktop");
  }

  async screenshot(target: GuestTarget): Promise<GuestScreenshot> {
    const response = await this.send(target, "GET", "/v1/screenshot");
    const bytes = await readLimited(response, 64 * 1024 * 1024);
    const width = Number(response.headers.get("x-agent-in-box-width"));
    const height = Number(response.headers.get("x-agent-in-box-height"));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new PersistenceError("unavailable", "Guest Agent 截图缺少有效分辨率元数据");
    }
    return {
      actionId: response.headers.get("x-agent-in-box-action-id") ?? "",
      width,
      height,
      capturedAt: new Date().toISOString(),
      dataBase64: Buffer.from(bytes).toString("base64"),
    };
  }

  async input(
    target: GuestTarget,
    action: GuestInputAction,
    actionId?: string,
    timeoutMs?: number,
  ): Promise<GuestActionResult> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = await this.request<Partial<GuestActionResult>>(target, "/v1/input", {
      ...action,
      ...(actionId ? { actionId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (typeof result.actionId !== "string" || typeof result.ok !== "boolean") {
      throw new PersistenceError("unavailable", "Guest Agent 返回了无效的动作结果");
    }
    return {
      actionId: result.actionId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      startedAt: result.startedAt ?? startedAt,
      durationMs: result.durationMs ?? Math.round(performance.now() - started),
    };
  }

  private async request<T>(target: GuestTarget, route: string, body?: unknown): Promise<T> {
    const response = await this.send(target, body === undefined ? "GET" : "POST", route, body);
    const bytes = await readLimited(response, 2 * 1024 * 1024);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
    } catch {
      throw new PersistenceError("unavailable", "Guest Agent 返回了无效 JSON");
    }
  }

  private async send(
    target: GuestTarget,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<Response> {
    if (!Number.isInteger(target.hostPort) || target.hostPort < 1 || target.hostPort > 65535) {
      throw new PersistenceError("unavailable", "VM 没有有效的 Guest Agent 回环端口");
    }
    const tokenFile = path.join(target.storageRoot, "guest-agent.token");
    const token = await readToken(tokenFile, this.sharedTokenFile);
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${target.hostPort}${route}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 60_000)),
      });
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `Guest Agent 不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const payload = await readLimited(response, 1024 * 1024).catch(() => new Uint8Array());
      let message = `Guest Agent 返回 HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          error?: { message?: string };
        };
        message = parsed.error?.message ?? message;
      } catch {
        // Preserve the bounded HTTP error when the peer did not return JSON.
      }
      throw new PersistenceError(response.status === 401 ? "unauthorized" : "unavailable", message);
    }
    return response;
  }
}

async function readToken(preferred: string, fallback: string | undefined): Promise<string> {
  const candidates = fallback ? [preferred, fallback] : [preferred];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("令牌路径不是普通文件");
      const token = (await readFile(candidate, "utf8")).trim();
      if (!token) throw new Error("令牌为空");
      return token;
    } catch (error) {
      lastError = error;
    }
  }
  throw new PersistenceError(
    "unavailable",
    `无法读取 VM 的 Guest Agent 令牌：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new PersistenceError("unavailable", "Guest Agent 响应超过大小限制");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PersistenceError("unavailable", "Guest Agent 响应超过大小限制");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
