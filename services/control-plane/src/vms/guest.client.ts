import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  GuestActionResult,
  GuestAgentCapabilities,
  GuestDesktopInfo,
  GuestHeartbeat,
  GuestInputAction,
  GuestScreenshot,
  GuestVerifyRequest,
  GuestVerifyResult,
  GuestVersionHandshake,
} from "@agent-in-box/protocol";
import { GUEST_PROTOCOL_VERSION } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";

export const GUEST_CLIENT_OPTIONS = Symbol("AGENT_IN_BOX_GUEST_CLIENT_OPTIONS");

/** Mirrors the Guest Agent workspace archive cap; larger workspaces need a host-side backup. */
export const MAX_WORKSPACE_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface GuestClientOptions {
  fetchImpl?: typeof fetch;
  tokenFile?: string;
  timeoutMs?: number;
}

export interface GuestTarget {
  hostPort: number;
  storageRoot: string;
  /**
   * Host address that QEMU forwarded the Guest Agent port to. It defaults to
   * the host-only loopback alias so an in-guest process cannot reach the
   * forwarded port through the 10.0.2.2 host alias.
   */
  host?: string;
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

  async verify(target: GuestTarget, request: GuestVerifyRequest): Promise<GuestVerifyResult> {
    const result = await this.request<GuestVerifyResult>(target, "/v1/verify", request);
    if (
      typeof result?.actionId !== "string" ||
      typeof result.ok !== "boolean" ||
      !Array.isArray(result.checks)
    ) {
      throw new PersistenceError("unavailable", "Guest Agent 返回了无效的校验结果");
    }
    return result;
  }

  /**
   * Streams a Guest workspace tar.gz to the host and verifies its SHA-256.
   * The destination must be a new file; callers own its directory.
   */
  async downloadWorkspace(
    target: GuestTarget,
    workspacePath: string,
    destination: string,
  ): Promise<{ sha256: string; sizeBytes: number; fileCount: number }> {
    const response = await this.sendRaw(
      target,
      "GET",
      `/v1/workspace/archive?path=${encodeURIComponent(workspacePath)}`,
      undefined,
      undefined,
      15 * 60_000,
    );
    const expectedSha = response.headers.get("x-agent-in-box-sha256") ?? "";
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_WORKSPACE_ARCHIVE_BYTES) {
      throw new PersistenceError("unavailable", "Guest workspace archive 超过大小限制");
    }
    const body = response.body;
    if (!body) throw new PersistenceError("unavailable", "Guest Agent 未返回 workspace archive");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > MAX_WORKSPACE_ARCHIVE_BYTES) {
          callback(new PersistenceError("unavailable", "Guest workspace archive 超过大小限制"));
          return;
        }
        hash.update(buffer);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body as unknown as NodeReadableStream),
        counter,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        "unavailable",
        `下载 Guest workspace archive 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sha256 = hash.digest("hex");
    if (expectedSha && expectedSha !== sha256) {
      await unlink(destination).catch(() => undefined);
      throw new PersistenceError("unavailable", "Guest workspace archive SHA-256 校验失败");
    }
    const fileCount = Number(response.headers.get("x-agent-in-box-files"));
    return {
      sha256,
      sizeBytes,
      fileCount: Number.isFinite(fileCount) ? fileCount : 0,
    };
  }

  /** Uploads a verified workspace tar.gz and lets the Guest Agent replace the directory. */
  async restoreWorkspace(
    target: GuestTarget,
    workspacePath: string,
    filePath: string,
    sha256: string,
  ): Promise<{ fileCount: number; sizeBytes: number }> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_WORKSPACE_ARCHIVE_BYTES) {
      throw new PersistenceError("unavailable", "项目备份文件不存在或超过大小限制");
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new PersistenceError("unavailable", "项目备份缺少有效的 SHA-256");
    }
    const response = await this.sendRaw(
      target,
      "POST",
      `/v1/workspace/restore?path=${encodeURIComponent(workspacePath)}`,
      Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
      {
        "content-type": "application/gzip",
        "content-length": String(info.size),
        "x-agent-in-box-sha256": sha256,
      },
      15 * 60_000,
    );
    const bytes = await readLimited(response, 1024 * 1024);
    try {
      const result = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        fileCount?: unknown;
        sizeBytes?: unknown;
      };
      return {
        fileCount: typeof result.fileCount === "number" ? result.fileCount : 0,
        sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : 0,
      };
    } catch {
      throw new PersistenceError("unavailable", "Guest Agent 返回了无效的 workspace 恢复结果");
    }
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

  private send(
    target: GuestTarget,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<Response> {
    return this.sendRaw(
      target,
      method,
      route,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? undefined : { "content-type": "application/json" },
      Math.min(this.timeoutMs, 60_000),
    );
  }

  private async sendRaw(
    target: GuestTarget,
    method: "GET" | "POST",
    route: string,
    body: BodyInit | undefined,
    extraHeaders: Record<string, string> | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    if (!Number.isInteger(target.hostPort) || target.hostPort < 1 || target.hostPort > 65535) {
      throw new PersistenceError("unavailable", "VM 没有有效的 Guest Agent 回环端口");
    }
    const tokenFile = path.join(target.storageRoot, "guest-agent.token");
    const token = await readToken(tokenFile, this.sharedTokenFile);
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${target.host ?? "127.0.0.2"}:${target.hostPort}${route}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(extraHeaders ?? {}),
        },
        ...(body !== undefined ? { body } : {}),
        ...(body !== undefined && isNodeStreamBody(body) ? { duplex: "half" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `Guest Agent 不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const payload = await readLimited(response, 1024 * 1024).catch(() => new Uint8Array());
      let message = `Guest Agent 返回 HTTP ${response.status}`;
      let guestCode: string | null = null;
      try {
        const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          error?: string | { code?: string; message?: string };
          errorCode?: string;
        };
        if (typeof parsed.error === "string") {
          message = parsed.error;
        } else {
          message = parsed.error?.message ?? message;
          guestCode = parsed.error?.code ?? null;
        }
        if (typeof parsed.errorCode === "string") guestCode = parsed.errorCode;
      } catch {
        // Preserve the bounded HTTP error when the peer did not return JSON.
      }
      throw new PersistenceError(
        response.status === 401
          ? "unauthorized"
          : response.status === 423
            ? "conflict"
            : "unavailable",
        message,
        guestCode ? { guestCode } : undefined,
      );
    }
    return response;
  }
}

function isNodeStreamBody(body: BodyInit): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
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
