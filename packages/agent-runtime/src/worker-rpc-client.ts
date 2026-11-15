import { lstat, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerEngineEvent,
  type WorkerInput,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "./index";

const WORKER_RPC_LONG_TIMEOUT_MS = 180_000;

export interface WorkerRpcClientOptions {
  baseUrl: string;
  token?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface WorkerSessionView extends WorkerSessionHandle {
  workerId: string;
  status: "active" | "archived" | "failed";
}

interface WorkerEventEnvelope {
  id: number;
  sessionId: string;
  event: WorkerEngineEvent;
}

export class WorkerRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkerRpcError";
  }
}

/** Host-side client for the authenticated in-guest Worker RPC service. */
export class WorkerRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WorkerRpcClientOptions) {
    const url = new URL(options.baseUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error("Worker RPC baseUrl must be a loopback HTTP URL without credentials");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async handshake(): Promise<{
    protocolVersion: string;
    engineType: string;
    engineVersion: string;
    sessionVersion: string;
    compatible: boolean;
    compatibilityError?: string;
  }> {
    // A protocol mismatch is a structured 409, not a transport failure. Keep
    // its body so the host can report the exact incompatible versions.
    return this.request(
      "GET",
      `/v1/version?protocolVersion=${encodeURIComponent(WORKER_RPC_PROTOCOL_VERSION)}`,
      undefined,
      [409],
    );
  }

  startSession(spec: WorkerSessionSpec): Promise<WorkerSessionView> {
    return this.request("POST", "/v1/sessions", { spec }, [], WORKER_RPC_LONG_TIMEOUT_MS);
  }

  session(sessionId: string): Promise<WorkerSessionView> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  prompt(sessionId: string, input: WorkerInput): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, input);
  }

  steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    return this.request<{ disposition: "queued" | "handled" }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/steer`,
      input,
    ).then((result) => result.disposition);
  }

  followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    return this.request<{ disposition: "queued" | "handled" }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/follow-up`,
      input,
    ).then((result) => result.disposition);
  }

  abort(sessionId: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/abort`, {});
  }

  archive(sessionId: string): Promise<{ archiveRef: string; summary: string }> {
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
      {},
      [],
      WORKER_RPC_LONG_TIMEOUT_MS,
    );
  }

  resume(
    archiveRef: string,
    spec: WorkerSessionSpec,
  ): Promise<WorkerSessionView & { mode: "native" | "summary" }> {
    return this.request(
      "POST",
      "/v1/sessions/resume",
      { archiveRef, spec },
      [],
      WORKER_RPC_LONG_TIMEOUT_MS,
    );
  }

  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void {
    const controller = new AbortController();
    let after = 0;
    let stopped = false;
    const run = async (): Promise<void> => {
      let retryMs = 200;
      while (!stopped) {
        try {
          const token = await this.token();
          const response = await this.fetchImpl(
            `${this.baseUrl}/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=${after}`,
            {
              headers: {
                accept: "text/event-stream",
                authorization: `Bearer ${token}`,
              },
              signal: controller.signal,
              redirect: "error",
            },
          );
          if (!response.ok) {
            const error = await this.responseError(response);
            if (response.status === 401 || response.status === 404) {
              listener({ type: "session_failed", message: error.message });
              return;
            }
            throw error;
          }
          if (!response.body) throw new Error("Worker RPC event stream has no body");
          retryMs = 200;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const parsed = parseSseBlock(block);
              if (parsed) {
                after = Math.max(after, parsed.id);
                if (parsed.event.type === "stream_gap") {
                  listener({
                    type: "session_failed",
                    message: "Worker 事件流出现缺口，Worker 会话需要重新同步",
                  });
                  controller.abort();
                  return;
                }
                if (parsed.sessionId === sessionId) listener(parsed.event);
              }
              boundary = buffer.indexOf("\n\n");
            }
            if (buffer.length > 4 * 1024 * 1024) {
              throw new Error("Worker RPC event stream record exceeds the size limit");
            }
          }
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof WorkerRpcError && !error.retryable) {
            listener({ type: "session_failed", message: error.message });
            return;
          }
        }
        if (stopped) return;
        await delay(retryMs, controller.signal).catch(() => undefined);
        retryMs = Math.min(5000, retryMs * 2);
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    acceptStatuses: readonly number[] = [],
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new WorkerRpcError(
        `Worker RPC is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "unavailable",
        503,
        true,
      );
    }
    if (!response.ok && !acceptStatuses.includes(response.status)) {
      throw await this.responseError(response);
    }
    const bytes = await readLimited(response, 4 * 1024 * 1024);
    if (bytes.byteLength === 0) return undefined as T;
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
    } catch {
      throw new WorkerRpcError("Worker RPC returned invalid JSON", "protocol_error", 502, true);
    }
  }

  private async responseError(response: Response): Promise<WorkerRpcError> {
    const bytes = await readLimited(response, 1024 * 1024).catch(() => new Uint8Array());
    let remote: { code?: string; message?: string; retryable?: boolean } = {};
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        error?: { code?: string; message?: string; retryable?: boolean };
      };
      remote = parsed.error ?? {};
    } catch {
      // Keep a bounded transport error when the peer did not return JSON.
    }
    return new WorkerRpcError(
      remote.message ?? `Worker RPC returned HTTP ${response.status}`,
      remote.code ?? (response.status === 401 ? "unauthorized" : "unavailable"),
      response.status,
      remote.retryable ?? response.status >= 500,
    );
  }

  private async token(): Promise<string> {
    if (this.options.token) return this.options.token;
    if (!this.options.tokenFile) throw new Error("Worker RPC token or tokenFile is required");
    const info = await lstat(this.options.tokenFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
      throw new Error("Worker RPC token must be a small regular non-symlink file");
    }
    const token = (await readFile(this.options.tokenFile, "utf8")).trim();
    if (!token) throw new Error("Worker RPC token is empty");
    return token;
  }
}

function parseSseBlock(block: string): WorkerEventEnvelope | null {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isSafeInteger(parsed) && parsed >= 0) id = parsed;
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (id === null || data.length === 0) return null;
  let event: WorkerEventEnvelope;
  try {
    event = JSON.parse(data.join("\n")) as WorkerEventEnvelope;
  } catch {
    throw new WorkerRpcError(
      "Worker RPC event stream is malformed",
      "protocol_error",
      502,
      false,
    );
  }
  if (event.id !== id || typeof event.sessionId !== "string") {
    throw new WorkerRpcError(
      "Worker RPC event stream id does not match its payload",
      "protocol_error",
      502,
      false,
    );
  }
  return event;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new WorkerRpcError(
      "Worker RPC response exceeds the size limit",
      "protocol_error",
      502,
      true,
    );
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
      throw new WorkerRpcError(
        "Worker RPC response exceeds the size limit",
        "protocol_error",
        502,
        true,
      );
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

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Worker event subscription stopped"));
      },
      { once: true },
    );
  });
}

/** Exported for tests that compare token rotation without exposing token contents. */
export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
