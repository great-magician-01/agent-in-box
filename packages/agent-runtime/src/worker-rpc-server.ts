import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  PI_ENGINE_VERSION,
  PI_SESSION_FORMAT_VERSION,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerCapability,
  type WorkerEngine,
  type WorkerEngineEvent,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "./index";
import { tokensEqual, type WorkerSessionView } from "./worker-rpc-client";

interface EventEnvelope {
  id: number;
  sessionId: string;
  event: WorkerEngineEvent;
}

interface SessionRecord {
  workerId: string;
  handle: WorkerSessionHandle;
  status: WorkerSessionView["status"];
  nextEventId: number;
  events: EventEnvelope[];
  eventBytes: number;
  streams: Set<ServerResponse<IncomingMessage>>;
}

const MAX_REPLAY_EVENTS = 1000;
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_STRING = 256 * 1024;
const MAX_EVENT_DEPTH = 12;

/**
 * Tool results may contain base64 screenshots. The host does not need those
 * bytes for replay/trace, and keeping them in the 1000-event ring would let a
 * single Worker exhaust Guest memory. Truncate oversized strings and cap the
 * traversal depth before an event is stored or streamed.
 */
function sanitizeEventValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_EVENT_STRING
      ? value
      : `[truncated ${value.length} chars]`;
  }
  if (depth >= MAX_EVENT_DEPTH) return "[truncated: depth limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeEventValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = sanitizeEventValue(item, depth + 1);
    }
    return record;
  }
  return value;
}

export interface WorkerRpcServerOptions {
  engine: WorkerEngine & { dispose?: () => Promise<void> };
  tokenFile: string;
  host?: string;
  port?: number;
  engineVersion?: string;
  sessionVersion?: string;
}

const CAPABILITIES = new Set<WorkerCapability>([
  "filesystem",
  "shell",
  "computer_use",
  "browser",
  "read_only",
]);

/** Authenticated in-guest RPC service. It never exposes the host Supervisor or Provider key. */
export class WorkerRpcServer {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly server: Server;
  private readonly sockets = new Set<import("node:net").Socket>();
  private started = false;

  constructor(private readonly options: WorkerRpcServerOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.writeError(response, error);
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.started) throw new Error("Worker RPC server is already started");
    const host = this.options.host ?? "0.0.0.0";
    const port = this.options.port ?? 7612;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.started = true;
    return { host, port: (this.server.address() as AddressInfo).port };
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const stream of session.streams) stream.end();
      session.streams.clear();
    }
    for (const socket of this.sockets) socket.destroy();
    if (this.started) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.started = false;
    }
    await this.options.engine.dispose?.();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.json(response, 200, { status: "ok", service: "agent-in-box-worker" });
      return;
    }
    if (!(await this.authorized(request))) {
      this.error(response, 401, "unauthorized", "invalid Worker RPC bearer token", false);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/version") {
      const requested = url.searchParams.get("protocolVersion") ?? "";
      const compatible = requested === WORKER_RPC_PROTOCOL_VERSION;
      this.json(response, compatible ? 200 : 409, {
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        engineType: this.options.engine.type,
        engineVersion: this.options.engineVersion ?? PI_ENGINE_VERSION,
        sessionVersion: this.options.sessionVersion ?? PI_SESSION_FORMAT_VERSION,
        requestedProtocolVersion: requested,
        compatible,
        ...(compatible
          ? {}
          : { compatibilityError: "Worker RPC protocol version is incompatible" }),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) {
        this.error(response, 400, "bad_request", "after must be a non-negative integer", false);
        return;
      }
      this.events(this.requireSession(sessionId), after, request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = (await this.body(request)) as { spec?: unknown };
      const spec = validateSpec(body.spec);
      this.assertVersion(spec);
      const handle = await this.options.engine.startSession(spec);
      const view = this.register(spec, handle);
      this.json(response, 201, view);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions/resume") {
      const body = (await this.body(request)) as { archiveRef?: unknown; spec?: unknown };
      if (typeof body.archiveRef !== "string" || !body.archiveRef) {
        this.error(response, 400, "bad_request", "archiveRef is required", false);
        return;
      }
      const spec = validateSpec(body.spec);
      this.assertVersion(spec);
      const handle = await this.options.engine.resume(body.archiveRef, spec);
      const view = { ...this.register(spec, handle), mode: handle.mode };
      this.json(response, 200, view);
      return;
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/(prompt|steer|follow-up|abort|archive))?$/.exec(
      url.pathname,
    );
    if (!match) {
      this.error(response, 404, "not_found", "Worker RPC route not found", false);
      return;
    }
    const sessionId = decodeURIComponent(match[1] ?? "");
    const record = this.requireSession(sessionId);
    const action = match[2];
    if (request.method === "GET" && !action) {
      this.json(response, 200, this.view(record));
      return;
    }
    if (request.method !== "POST" || !action) {
      this.error(response, 404, "not_found", "Worker RPC route not found", false);
      return;
    }
    const input = (await this.body(request)) as {
      text?: unknown;
      attachments?: unknown;
      images?: unknown;
    };
    switch (action) {
      case "prompt":
        await this.options.engine.prompt(sessionId, validateInput(input));
        this.json(response, 200, { accepted: true });
        break;
      case "steer":
        this.json(response, 200, {
          disposition: await this.options.engine.steer(sessionId, validateInput(input)),
        });
        break;
      case "follow-up":
        this.json(response, 200, {
          disposition: await this.options.engine.followUp(sessionId, validateInput(input)),
        });
        break;
      case "abort":
        await this.options.engine.abort(sessionId);
        this.json(response, 200, { accepted: true });
        break;
      case "archive": {
        const archived = await this.options.engine.archive(sessionId);
        record.handle = { ...record.handle, archiveRef: archived.archiveRef };
        record.status = "archived";
        this.json(response, 200, archived);
        break;
      }
    }
  }

  private register(spec: WorkerSessionSpec, handle: WorkerSessionHandle): WorkerSessionView {
    const previous = this.sessions.get(handle.sessionId);
    if (previous) {
      for (const stream of previous.streams) stream.end();
      this.sessions.delete(handle.sessionId);
    }
    const record: SessionRecord = {
      workerId: spec.workerId,
      handle,
      status: "active",
      nextEventId: 1,
      events: [],
      eventBytes: 0,
      streams: new Set(),
    };
    this.sessions.set(handle.sessionId, record);
    this.options.engine.subscribe(handle.sessionId, (event) => {
      if (event.type === "session_failed") record.status = "failed";
      const safeEvent = sanitizeEventValue(event) as WorkerEngineEvent;
      const envelope: EventEnvelope = {
        id: record.nextEventId++,
        sessionId: handle.sessionId,
        event: safeEvent,
      };
      record.events.push(envelope);
      record.eventBytes += Buffer.byteLength(JSON.stringify(envelope));
      while (
        record.events.length > MAX_REPLAY_EVENTS ||
        record.eventBytes > MAX_REPLAY_BYTES
      ) {
        const removed = record.events.shift();
        if (!removed) break;
        record.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
      }
      for (const stream of record.streams) writeSse(stream, envelope);
    });
    return this.view(record);
  }

  private events(
    record: SessionRecord,
    after: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    record.streams.add(response);
    const oldest = record.events[0];
    if (after > 0 && oldest && after < oldest.id - 1) {
      // The client asked for an event that has already been evicted. Tell it
      // explicitly instead of silently replaying a discontinuous stream.
      writeSse(response, {
        id: oldest.id - 1,
        sessionId: record.handle.sessionId,
        event: {
          type: "stream_gap",
          oldestEventId: oldest.id,
          latestEventId: record.nextEventId - 1,
        },
      });
    }
    for (const event of record.events) {
      if (event.id > after) writeSse(response, event);
    }
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.on("close", () => {
      clearInterval(heartbeat);
      record.streams.delete(response);
    });
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new RpcHttpError(404, "not_found", "Worker session not found", false);
    return record;
  }

  private view(record: SessionRecord): WorkerSessionView {
    return {
      ...record.handle,
      workerId: record.workerId,
      status: record.status,
    };
  }

  private assertVersion(spec: WorkerSessionSpec): void {
    const engineVersion = this.options.engineVersion ?? PI_ENGINE_VERSION;
    const sessionVersion = this.options.sessionVersion ?? PI_SESSION_FORMAT_VERSION;
    if (
      spec.engineType !== this.options.engine.type ||
      (spec.engineVersion && spec.engineVersion !== engineVersion) ||
      (spec.sessionVersion && spec.sessionVersion !== sessionVersion)
    ) {
      throw new RpcHttpError(
        409,
        "incompatible_version",
        `Worker Engine/Session version is incompatible; required ${engineVersion}/${sessionVersion}`,
        false,
      );
    }
  }

  private async authorized(request: IncomingMessage): Promise<boolean> {
    try {
      const info = await lstat(this.options.tokenFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return false;
      const token = (await readFile(this.options.tokenFile, "utf8")).trim();
      if (!token) return false;
      const authorization = request.headers.authorization ?? "";
      return tokensEqual(authorization, `Bearer ${token}`);
    } catch {
      return false;
    }
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      // Resume/environment injection may carry one host-captured PNG inline.
      if (total > 16 * 1024 * 1024) {
        throw new RpcHttpError(413, "bad_request", "Worker RPC request is too large", false);
      }
      chunks.push(buffer);
    }
    if (total === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new RpcHttpError(400, "bad_request", "Worker RPC body must be a JSON object", false);
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private error(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.json(response, status, { error: { code, message, retryable } });
  }

  private writeError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof RpcHttpError) {
      this.error(response, error.status, error.code, error.message, error.retryable);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const incompatible = /incompatible|version/i.test(message);
    const missing = /unknown.*session/i.test(message);
    this.error(
      response,
      incompatible ? 409 : missing ? 404 : 500,
      incompatible ? "incompatible_version" : missing ? "not_found" : "runtime_error",
      message.slice(0, 2000),
      !incompatible && !missing,
    );
  }
}

class RpcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function validateSpec(value: unknown): WorkerSessionSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcHttpError(400, "bad_request", "Worker session spec is required", false);
  }
  const spec = value as Record<string, unknown>;
  for (const field of ["workerId", "projectId", "vmId", "workspacePath", "engineType"] as const) {
    if (typeof spec[field] !== "string" || !(spec[field] as string).trim()) {
      throw new RpcHttpError(400, "bad_request", `${field} must be a non-empty string`, false);
    }
  }
  if (
    typeof spec.workspacePath !== "string" ||
    !path.isAbsolute(spec.workspacePath) ||
    spec.workspacePath.split(/[\\/]/).includes("..")
  ) {
    throw new RpcHttpError(
      400,
      "bad_request",
      "workspacePath must be an absolute guest path",
      false,
    );
  }
  if (
    !Array.isArray(spec.capabilities) ||
    spec.capabilities.some(
      (capability) =>
        typeof capability !== "string" || !CAPABILITIES.has(capability as WorkerCapability),
    )
  ) {
    throw new RpcHttpError(400, "bad_request", "capabilities are invalid", false);
  }
  if (spec.mcpEnabled !== undefined && typeof spec.mcpEnabled !== "boolean") {
    throw new RpcHttpError(400, "bad_request", "mcpEnabled must be a boolean", false);
  }
  if (spec.systemPrompt !== undefined && typeof spec.systemPrompt !== "string") {
    throw new RpcHttpError(400, "bad_request", "systemPrompt must be a string", false);
  }
  if (spec.modelBroker !== undefined) {
    const broker = spec.modelBroker as Record<string, unknown>;
    if (
      typeof broker !== "object" ||
      broker === null ||
      typeof broker.baseUrl !== "string" ||
      typeof broker.token !== "string" ||
      typeof broker.provider !== "string" ||
      typeof broker.model !== "string" ||
      (broker.api !== "openai-completions" && broker.api !== "anthropic-messages")
    ) {
      throw new RpcHttpError(400, "bad_request", "modelBroker is invalid", false);
    }
  }
  if (spec.computerUse !== undefined) {
    const cua = spec.computerUse as Record<string, unknown>;
    if (
      typeof cua !== "object" ||
      cua === null ||
      typeof cua.baseUrl !== "string" ||
      !cua.baseUrl.trim() ||
      typeof cua.token !== "string" ||
      !cua.token
    ) {
      throw new RpcHttpError(400, "bad_request", "computerUse is invalid", false);
    }
  }
  if (spec.pluginDevelopment !== undefined) {
    const development = spec.pluginDevelopment as Record<string, unknown>;
    if (
      typeof development !== "object" ||
      development === null ||
      typeof development.baseUrl !== "string" ||
      !development.baseUrl.trim() ||
      typeof development.token !== "string" ||
      !development.token ||
      !spec.capabilities.includes("shell") ||
      !spec.capabilities.includes("filesystem")
    ) {
      throw new RpcHttpError(400, "bad_request", "pluginDevelopment is invalid", false);
    }
  }
  if (spec.pluginSnapshotId !== undefined && typeof spec.pluginSnapshotId !== "string") {
    throw new RpcHttpError(400, "bad_request", "pluginSnapshotId must be a string", false);
  }
  if (
    spec.pluginPackages !== undefined &&
    (!Array.isArray(spec.pluginPackages) || spec.pluginPackages.length > 32)
  ) {
    throw new RpcHttpError(400, "bad_request", "pluginPackages must be a bounded array", false);
  }
  return spec as unknown as WorkerSessionSpec;
}

function validateInput(input: { text?: unknown; attachments?: unknown; images?: unknown }): {
  text: string;
  attachments?: readonly string[];
  images?: readonly { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }[];
} {
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000) {
    throw new RpcHttpError(
      400,
      "bad_request",
      "Worker input text must be 1..100000 characters",
      false,
    );
  }
  if (
    input.attachments !== undefined &&
    (!Array.isArray(input.attachments) ||
      input.attachments.length > 8 ||
      input.attachments.some(
        (item) => typeof item !== "string" || !path.isAbsolute(item) || item.includes(".."),
      ))
  ) {
    throw new RpcHttpError(
      400,
      "bad_request",
      "attachments must be guest-local absolute paths",
      false,
    );
  }
  if (input.images !== undefined) {
    if (
      !Array.isArray(input.images) ||
      input.images.length > 4 ||
      input.images.some((item) => {
        if (typeof item !== "object" || item === null) return true;
        const image = item as Record<string, unknown>;
        return (
          (image.mimeType !== "image/png" &&
            image.mimeType !== "image/jpeg" &&
            image.mimeType !== "image/webp") ||
          typeof image.data !== "string" ||
          image.data.length === 0 ||
          image.data.length > 16 * 1024 * 1024
        );
      })
    ) {
      throw new RpcHttpError(400, "bad_request", "inline images are invalid", false);
    }
  }
  return {
    text: input.text,
    ...(input.attachments !== undefined ? { attachments: input.attachments as string[] } : {}),
    ...(input.images !== undefined
      ? {
          images: input.images as Array<{
            mimeType: "image/png" | "image/jpeg" | "image/webp";
            data: string;
          }>,
        }
      : {}),
  };
}

function writeSse(response: ServerResponse, envelope: EventEnvelope): void {
  if (!response.destroyed) {
    response.write(`id: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
}
