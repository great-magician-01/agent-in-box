import fs from "node:fs";

export interface ServiceShutdownContext {
  baseUrl: string;
  instanceNonce: string;
  timeoutMs: number;
}

export type ServiceShutdownHandler = (context: ServiceShutdownContext) => Promise<void>;

export type ServiceShutdownErrorCode =
  | "INVALID_SERVICE_URL"
  | "IDENTITY_MISMATCH"
  | "CREDENTIAL_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "SHUTDOWN_UNSUPPORTED"
  | "SHUTDOWN_UNAUTHORIZED"
  | "SHUTDOWN_REQUEST_FAILED";

/** A failed shutdown is explicit: callers must not translate it into "stopped". */
export class ServiceShutdownError extends Error {
  readonly code: ServiceShutdownErrorCode;
  readonly status: number | null;

  constructor(code: ServiceShutdownErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "ServiceShutdownError";
    this.code = code;
    this.status = status;
  }
}

interface ShutdownClientOptions {
  fetchImpl?: typeof fetch;
}

export interface ControlPlaneShutdownClientOptions extends ShutdownClientOptions {
  accessKeyPath: string;
}

export interface VmSupervisorShutdownClientOptions extends ShutdownClientOptions {
  /** The token path follows the configured data root when supplied as a function. */
  tokenFile: string | (() => string);
}

function normalizedLoopbackBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServiceShutdownError("INVALID_SERVICE_URL", "本地服务停止地址无效");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "127.0.0.2", "localhost", "::1"].includes(hostname) ||
    url.username ||
    url.password
  ) {
    throw new ServiceShutdownError(
      "INVALID_SERVICE_URL",
      "认证停止只允许无凭据的本机回环 HTTP 地址",
    );
  }
  return raw.replace(/\/$/, "");
}

async function verifyIdentity(
  fetchImpl: typeof fetch,
  baseUrl: string,
  healthPath: string,
  service: "control-plane" | "vm-supervisor",
  instanceNonce: string,
  timeoutMs: number,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${healthPath}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    throw new ServiceShutdownError(
      "IDENTITY_MISMATCH",
      `停止前无法校验 ${service} 实例身份：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
    service?: unknown;
    instanceNonce?: unknown;
  } | null;
  if (
    !response.ok ||
    !body ||
    body.status !== "ok" ||
    body.service !== service ||
    body.instanceNonce !== instanceNonce
  ) {
    throw new ServiceShutdownError(
      "IDENTITY_MISMATCH",
      `${service} 实例身份不匹配，已拒绝发送停止凭据`,
      response.status,
    );
  }
}

function readCredential(filePath: string, label: string): string {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("不是普通文件");
    }
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!value || value.length > 16_384) throw new Error("为空或过长");
    return value;
  } catch (error) {
    throw new ServiceShutdownError(
      "CREDENTIAL_UNAVAILABLE",
      `无法读取${label}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function shutdownRequest(
  fetchImpl: typeof fetch,
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/shutdown`, {
      method: "POST",
      headers: { ...headers, accept: "application/json", "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    throw new ServiceShutdownError(
      "SHUTDOWN_REQUEST_FAILED",
      `${label}认证停止请求失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.ok) return;
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new ServiceShutdownError(
      "SHUTDOWN_UNSUPPORTED",
      `${label}不支持 POST /api/v1/shutdown；需要升级对应服务端组件`,
      response.status,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ServiceShutdownError(
      "SHUTDOWN_UNAUTHORIZED",
      `${label}认证停止被拒绝：HTTP ${response.status}`,
      response.status,
    );
  }
  throw new ServiceShutdownError(
    "SHUTDOWN_REQUEST_FAILED",
    `${label}认证停止失败：HTTP ${response.status}`,
    response.status,
  );
}

/**
 * Control Plane adapter contract:
 *   POST /api/v1/shutdown with Authorization: Bearer <installation access key>.
 *   The key is sent only after /api/v1/health proves the expected installation
 *   nonce. A Bearer request cannot be forged by a local web page (no CORS), so
 *   it is not subject to the browser CSRF token.
 */
export function createControlPlaneShutdownHandler(
  options: ControlPlaneShutdownClientOptions,
): ServiceShutdownHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (context) => {
    const baseUrl = normalizedLoopbackBaseUrl(context.baseUrl);
    await verifyIdentity(
      fetchImpl,
      baseUrl,
      "/api/v1/health",
      "control-plane",
      context.instanceNonce,
      context.timeoutMs,
    );
    const accessKey = readCredential(options.accessKeyPath, "本机访问密钥");
    await shutdownRequest(
      fetchImpl,
      baseUrl,
      { authorization: `Bearer ${accessKey}` },
      context.timeoutMs,
      "控制平面",
    );
  };
}

/**
 * VM Supervisor adapter contract:
 *   POST /api/v1/shutdown with Authorization: Bearer <supervisor-acl.token>.
 *   The token is sent only after /healthz proves the expected installation nonce.
 */
export function createVmSupervisorShutdownHandler(
  options: VmSupervisorShutdownClientOptions,
): ServiceShutdownHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (context) => {
    const baseUrl = normalizedLoopbackBaseUrl(context.baseUrl);
    await verifyIdentity(
      fetchImpl,
      baseUrl,
      "/healthz",
      "vm-supervisor",
      context.instanceNonce,
      context.timeoutMs,
    );
    const tokenFile =
      typeof options.tokenFile === "function" ? options.tokenFile() : options.tokenFile;
    const token = readCredential(tokenFile, "VM Supervisor ACL 令牌");
    await shutdownRequest(
      fetchImpl,
      baseUrl,
      { authorization: `Bearer ${token}` },
      context.timeoutMs,
      "VM Supervisor",
    );
  };
}
