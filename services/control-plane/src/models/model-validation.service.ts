import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  ModelDefinition,
  ModelValidationCategory,
  ModelValidationError,
  ModelValidationErrorCode,
  ModelValidationRequest,
  ModelValidationResult,
  WorkerModelApi,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { nowIso } from "../persistence/time";
import type { ModelCredentialProvider } from "./credential-provider";
import { ModelProviderService, type ResolvedModel } from "./model-provider.service";
import { MODEL_CREDENTIAL_PROVIDER } from "./tokens";

export const MODEL_VALIDATION_OPTIONS = Symbol("AGENT_IN_BOX_MODEL_VALIDATION_OPTIONS");

export interface ModelValidationOptions {
  fetchImpl?: typeof fetch;
  /** Hard deadline for connecting, sending, and draining the upstream response. */
  timeoutMs?: number;
  /** Maximum success-body bytes read; larger responses fail validation. */
  maxResponseBytes?: number;
  /** Maximum upstream error-body bytes inspected for classification hints. */
  maxErrorBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_ERROR_BODY_BYTES = 8 * 1024;
const VALIDATION_PROMPT = "ping";
const VALIDATION_MAX_OUTPUT_TOKENS = 16;
const ANTHROPIC_VERSION = "2023-06-01";

const ERROR_DETAILS: Record<
  ModelValidationErrorCode,
  { category: ModelValidationCategory; message: string }
> = {
  model_not_configured: {
    category: "validation_failed",
    message: "尚未配置可用的模型 Provider，或所选模型不在 Provider 白名单中",
  },
  credential_missing: {
    category: "validation_failed",
    message: "未找到该 Provider 的有效凭据，请重新填写 API Key",
  },
  credential_unavailable: {
    category: "unavailable",
    message: "无法读取模型凭据，请确认系统安全存储或凭据桥可用",
  },
  provider_authentication_failed: {
    category: "validation_failed",
    message: "模型服务鉴权失败，请检查 API Key 是否有效",
  },
  provider_access_denied: {
    category: "validation_failed",
    message: "模型服务拒绝访问，请检查账号权限、区域或工作区设置",
  },
  model_not_found: {
    category: "validation_failed",
    message: "模型不存在或当前账号无权使用该模型，请检查模型 ID",
  },
  model_invalid_request: {
    category: "validation_failed",
    message: "模型服务拒绝了验证请求，请检查模型 ID 和 Provider API 配置",
  },
  provider_rate_limited: {
    category: "unavailable",
    message: "模型服务当前限流，请稍后重试",
  },
  provider_timeout: {
    category: "unavailable",
    message: "模型服务响应超时，请检查网络后重试",
  },
  provider_unreachable: {
    category: "unavailable",
    message: "无法连接模型服务，请检查网络和 Provider Base URL",
  },
  provider_unavailable: {
    category: "unavailable",
    message: "模型服务暂时不可用，请稍后重试",
  },
  provider_response_too_large: {
    category: "unavailable",
    message: "模型服务响应超出验证上限，请检查 Base URL 是否指向了正确的模型接口",
  },
};

/**
 * Performs one minimal, non-streaming upstream request so an operator can tell
 * whether the stored credential and declared model actually work. It reuses
 * ModelProviderService.resolve for provider/model normalization and the same
 * host credential bridge as the Model Broker. The secret is only ever placed
 * in an authentication header; it is never returned, stored, or logged.
 */
@Injectable()
export class ModelValidationService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxErrorBodyBytes: number;

  constructor(
    private readonly providers: ModelProviderService,
    @Inject(MODEL_CREDENTIAL_PROVIDER) private readonly credentials: ModelCredentialProvider,
    @Optional()
    @Inject(MODEL_VALIDATION_OPTIONS)
    options: ModelValidationOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.maxErrorBodyBytes = positiveInteger(
      options.maxErrorBodyBytes,
      DEFAULT_MAX_ERROR_BODY_BYTES,
    );
  }

  async validate(request: ModelValidationRequest = {}): Promise<ModelValidationResult> {
    const requestedProviderId = normalizeRequestedId(request.providerId, "Provider 标识");
    const requestedModel = normalizeRequestedId(request.model, "模型 ID");
    const requested = {
      providerId: requestedProviderId ?? null,
      model: requestedModel ?? null,
    };

    let resolved: ResolvedModel;
    try {
      resolved = await this.providers.resolve(requestedProviderId, requestedModel, "worker");
    } catch (error) {
      return this.failure(null, false, configurationError(error), null, null, requested);
    }

    const supportsImage = declaredImageSupport(resolved.model);
    let secret: string;
    try {
      secret = await this.credentials.getSecret(resolved.provider.credentialProviderId);
    } catch (error) {
      const code: ModelValidationErrorCode =
        error instanceof PersistenceError && error.code === "unavailable"
          ? "credential_unavailable"
          : "credential_missing";
      return this.failure(resolved, supportsImage, code, null, null);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${resolved.provider.baseUrl}/${endpointFor(resolved.provider.api)}`,
          {
            method: "POST",
            headers: requestHeaders(resolved.provider.api, secret),
            body: JSON.stringify(validationBody(resolved.provider.api, resolved.model.id)),
            redirect: "error",
            signal: controller.signal,
          },
        );
      } catch {
        return this.failure(
          resolved,
          supportsImage,
          timedOut ? "provider_timeout" : "provider_unreachable",
          null,
          Date.now() - startedAt,
        );
      }

      if (response.ok) {
        try {
          if ((await drainBounded(response, this.maxResponseBytes)) === "too_large") {
            return this.failure(
              resolved,
              supportsImage,
              "provider_response_too_large",
              response.status,
              Date.now() - startedAt,
            );
          }
        } catch {
          return this.failure(
            resolved,
            supportsImage,
            timedOut ? "provider_timeout" : "provider_unavailable",
            response.status,
            Date.now() - startedAt,
          );
        }
        return {
          ok: true,
          providerId: resolved.provider.id,
          model: resolved.model.id,
          supportsImage,
          checkedAt: nowIso(),
          latencyMs: Date.now() - startedAt,
          upstreamStatus: response.status,
          error: null,
        };
      }

      // The body is only used for a short classification hint. It is bounded,
      // never returned, and never logged because providers may echo metadata.
      let hint = "";
      try {
        hint = await readErrorHint(response, this.maxErrorBodyBytes);
      } catch {
        // The status code alone still yields a stable classification.
      }
      return this.failure(
        resolved,
        supportsImage,
        classifyUpstreamStatus(response.status, hint),
        response.status,
        Date.now() - startedAt,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(
    resolved: ResolvedModel | null,
    supportsImage: boolean,
    error: ModelValidationErrorCode | ModelValidationError,
    upstreamStatus: number | null,
    latencyMs: number | null,
    requested?: { providerId: string | null; model: string | null },
  ): ModelValidationResult {
    const normalized: ModelValidationError =
      typeof error === "string" ? { code: error, ...ERROR_DETAILS[error] } : error;
    return {
      ok: false,
      providerId: resolved?.provider.id ?? requested?.providerId ?? null,
      model: resolved?.model.id ?? requested?.model ?? null,
      supportsImage,
      checkedAt: nowIso(),
      latencyMs,
      upstreamStatus,
      error: normalized,
    };
  }
}

function normalizeRequestedId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PersistenceError("validation_failed", `${label}必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new PersistenceError("validation_failed", `${label}长度必须在 1 到 200 个字符之间`);
  }
  return trimmed;
}

function endpointFor(api: WorkerModelApi): "chat/completions" | "messages" {
  return api === "openai-completions" ? "chat/completions" : "messages";
}

function requestHeaders(api: WorkerModelApi, secret: string): Record<string, string> {
  const common = { accept: "application/json", "content-type": "application/json" };
  return api === "openai-completions"
    ? { ...common, authorization: `Bearer ${secret}` }
    : { ...common, "x-api-key": secret, "anthropic-version": ANTHROPIC_VERSION };
}

function validationBody(api: WorkerModelApi, model: string): Record<string, unknown> {
  return api === "openai-completions"
    ? {
        model,
        messages: [{ role: "user", content: VALIDATION_PROMPT }],
        max_tokens: VALIDATION_MAX_OUTPUT_TOKENS,
        stream: false,
      }
    : {
        model,
        max_tokens: VALIDATION_MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: VALIDATION_PROMPT }],
        stream: false,
      };
}

function declaredImageSupport(model: ModelDefinition): boolean {
  // Undeclared input defaults to text+image, matching ModelDefinition.
  return (model.input ?? ["text", "image"]).includes("image");
}

function configurationError(error: unknown): ModelValidationError {
  if (error instanceof PersistenceError && error.code === "validation_failed") {
    return {
      code: "model_not_configured",
      category: "validation_failed",
      // Resolution messages are local, Chinese, and contain no credential.
      message: error.message,
    };
  }
  return {
    code: "provider_unavailable",
    category: "unavailable",
    message: "无法读取模型 Provider 配置，请稍后重试",
  };
}

function classifyUpstreamStatus(status: number, hint: string): ModelValidationErrorCode {
  switch (status) {
    case 401:
      return "provider_authentication_failed";
    case 403:
      return "provider_access_denied";
    case 404:
      return "model_not_found";
    case 408:
    case 504:
      return "provider_timeout";
    case 429:
      return "provider_rate_limited";
    default:
      break;
  }
  if (status >= 500) return "provider_unavailable";

  const text = hint.toLowerCase();
  if (/(api.?key|unauthori[sz]ed|authenticat|invalid token)/.test(text)) {
    return "provider_authentication_failed";
  }
  if (/(permission|access denied|forbidden|region|workspace)/.test(text)) {
    return "provider_access_denied";
  }
  if (
    /(model|模型)/.test(text) &&
    /(not found|not exist|does not exist|unknown|invalid|unsupported|no such)/.test(text)
  ) {
    return "model_not_found";
  }
  if (status >= 400 && status < 500) return "model_invalid_request";
  return "provider_unavailable";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Drains a successful response without ever buffering more than maxBytes. */
async function drainBounded(response: Response, maxBytes: number): Promise<"ok" | "too_large"> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return "too_large";
    }
  }
  if (!response.body) return "ok";

  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return "ok";
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads only a short prefix of an upstream error body for classification. */
async function readErrorHint(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const take = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(take);
      total += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
