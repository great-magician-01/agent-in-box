import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { ApiErrorCode, SupervisorVmState } from "@agent-in-box/protocol";
import { DatabaseService } from "../persistence/database.service";
import { PersistenceError } from "../persistence/errors";

export const SUPERVISOR_OPTIONS = Symbol("AGENT_IN_BOX_SUPERVISOR_OPTIONS");

export interface SupervisorOptions {
  baseUrl?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface SupervisorCreateSpec {
  id: string;
  name: string;
  osFamily: "linux" | "windows";
  baseImagePath: string;
  seedImagePath: string;
  provisioningUrl?: string;
  cpuCount: number;
  memoryMb: number;
  diskSizeGb: number;
  desktop: true;
  qmpPort: 0;
  sshHostPort: 0;
  guestHostPort: 0;
  workerHostPort: 0;
  vncDisplay: 0;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new PersistenceError("validation_failed", "Supervisor 地址必须是本机回环 HTTP 地址");
  }
  return value.replace(/\/$/, "");
}

@Injectable()
export class SupervisorClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    database: DatabaseService,
    @Optional() @Inject(SUPERVISOR_OPTIONS) options: SupervisorOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.AGENT_IN_BOX_SUPERVISOR_URL?.trim() ?? "http://127.0.0.1:7610",
    );
    this.tokenFile =
      options.tokenFile ??
      process.env.AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE?.trim() ??
      path.join(database.dataRoot, "supervisor-acl.token");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 100_000;
  }

  list(): Promise<SupervisorVmState[]> {
    return this.request<{ items: SupervisorVmState[] }>("GET", "/api/v1/vms").then(
      (result) => result.items,
    );
  }

  get(id: string): Promise<SupervisorVmState> {
    return this.request("GET", `/api/v1/vms/${encodeURIComponent(id)}`);
  }

  create(spec: SupervisorCreateSpec): Promise<SupervisorVmState> {
    return this.request("POST", "/api/v1/vms", spec);
  }

  start(id: string): Promise<SupervisorVmState> {
    return this.action(id, "start");
  }

  stop(id: string, mode: "graceful" | "force"): Promise<SupervisorVmState> {
    return this.action(id, "stop", { mode });
  }

  suspend(id: string): Promise<SupervisorVmState> {
    return this.action(id, "suspend");
  }

  resume(id: string): Promise<SupervisorVmState> {
    return this.action(id, "resume");
  }

  console(id: string): Promise<string> {
    return this.request<{ consoleUrl: string }>(
      "GET",
      `/api/v1/vms/${encodeURIComponent(id)}/console`,
    ).then((result) => result.consoleUrl);
  }

  createSnapshot(id: string, tag: string): Promise<SupervisorVmState> {
    return this.request("POST", `/api/v1/vms/${encodeURIComponent(id)}/snapshots`, { tag });
  }

  restoreSnapshot(id: string, tag: string): Promise<SupervisorVmState> {
    return this.request("POST", `/api/v1/vms/${encodeURIComponent(id)}/snapshots/restore`, {
      tag,
    });
  }

  delete(id: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/api/v1/vms/${encodeURIComponent(id)}`);
  }

  private action(id: string, action: string, body: unknown = {}): Promise<SupervisorVmState> {
    return this.request("POST", `/api/v1/vms/${encodeURIComponent(id)}/${action}`, body);
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let token: string;
    try {
      const info = await lstat(this.tokenFile);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("ACL 令牌路径不是普通文件");
      }
      token = (await readFile(this.tokenFile, "utf8")).trim();
      if (!token) {
        throw new Error("ACL 令牌为空");
      }
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `无法读取 Supervisor ACL 令牌 ${this.tokenFile}：${error instanceof Error ? error.message : String(error)}`,
      );
    }

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
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `VM Supervisor 不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const remote =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { code?: string; message?: string } }).error
          : undefined;
      const code: ApiErrorCode =
        response.status === 404
          ? "not_found"
          : response.status === 409
            ? "conflict"
            : response.status === 400
              ? "validation_failed"
              : response.status === 401 || response.status === 403
                ? "unauthorized"
                : response.status >= 500
                  ? "unavailable"
                  : "bad_request";
      throw new PersistenceError(
        code,
        remote?.message ?? `Supervisor 返回 HTTP ${response.status}`,
      );
    }
    return payload as T;
  }
}
