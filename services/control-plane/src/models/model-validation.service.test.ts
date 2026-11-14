import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCredentialProvider } from "./credential-provider";
import { ModelProviderService } from "./model-provider.service";
import { ModelValidationService, type ModelValidationOptions } from "./model-validation.service";
import { PersistenceError } from "../persistence/errors";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService } from "../settings/settings.service";

const SECRET = "sk-test-secret-value-never-returned";
const OPENAI_URL = "https://models.example.test/v1";

let ctx: TestContext;
let providers: ModelProviderService;
let getSecret: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  ctx = await createTestContext();
  providers = new ModelProviderService(ctx.app.db, new SettingsService(ctx.app.db));
  await providers.upsert("openai", {
    baseUrl: OPENAI_URL,
    api: "openai-completions",
    credentialProviderId: "openai-key",
    models: [
      { id: "vision-model", input: ["text", "image"] },
      { id: "text-model", input: ["text"] },
      { id: "default-model" },
    ],
  });
  await providers.upsert("anthropic", {
    baseUrl: "https://anthropic.example.test",
    api: "anthropic-messages",
    credentialProviderId: "anthropic-key",
    models: [{ id: "claude-test" }],
  });
  await providers.upsert("missing-key", {
    baseUrl: "https://missing.example.test/v1",
    api: "openai-completions",
    credentialProviderId: "missing-key",
    models: [{ id: "missing-key-model" }],
  });
  await providers.upsert("bridge-key", {
    baseUrl: "https://bridge.example.test/v1",
    api: "openai-completions",
    credentialProviderId: "bridge-key",
    models: [{ id: "bridge-model" }],
  });
  getSecret = vi.fn(async (providerId: string) => {
    if (providerId === "missing-key") {
      throw new PersistenceError("validation_failed", "系统安全存储中没有该凭据");
    }
    if (providerId === "bridge-key") {
      throw new PersistenceError("unavailable", "Electron 凭据桥不可用");
    }
    return SECRET;
  });
});

afterEach(async () => {
  await ctx.close();
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeService(
  fetchImpl: typeof fetch,
  options: Omit<ModelValidationOptions, "fetchImpl"> = {},
): ModelValidationService {
  const credentials: ModelCredentialProvider = { getSecret };
  return new ModelValidationService(providers, credentials, { fetchImpl, ...options });
}

describe("ModelValidationService", () => {
  it("validates an OpenAI-compatible provider with one minimal request", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ choices: [] }));
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result).toMatchObject({
      ok: true,
      providerId: "openai",
      model: "vision-model",
      supportsImage: true,
      upstreamStatus: 200,
      error: null,
    });
    expect(result.latencyMs).not.toBeNull();
    expect(getSecret).toHaveBeenCalledWith("openai-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${OPENAI_URL}/chat/completions`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "vision-model", max_tokens: 16, stream: false });
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("uses the Anthropic Messages wire format and defaults undeclared models to image support", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ content: [] }));
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "anthropic", model: "claude-test" });

    expect(result).toMatchObject({
      ok: true,
      providerId: "anthropic",
      model: "claude-test",
      supportsImage: true,
      error: null,
    });
    expect(calls[0]?.url).toBe("https://anthropic.example.test/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(SECRET);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "claude-test", max_tokens: 16, stream: false });
  });

  it("reports declared text-only models without probing images", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ choices: [] }));
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "openai", model: "text-model" });

    expect(result).toMatchObject({ ok: true, supportsImage: false });
    // Exactly one text request; no image payload is ever sent.
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.init.body)).not.toContain("image");
  });

  it("resolves the current selection when no explicit provider or model is given", async () => {
    await new SettingsService(ctx.app.db).updateModelSelection({
      worker: { providerId: "anthropic", model: "claude-test" },
    });
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ content: [] }));
    const service = makeService(fetchImpl);

    const result = await service.validate();

    expect(result).toMatchObject({
      ok: true,
      providerId: "anthropic",
      model: "claude-test",
    });
    expect(calls[0]?.url).toBe("https://anthropic.example.test/messages");
    expect(calls).toHaveLength(1);
  });

  it("fails closed on an unknown provider or model without calling upstream", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ choices: [] }));
    const service = makeService(fetchImpl);

    const unknownProvider = await service.validate({ providerId: "nope", model: "vision-model" });
    expect(unknownProvider).toMatchObject({
      ok: false,
      providerId: "nope",
      model: "vision-model",
      supportsImage: false,
      error: { code: "model_not_configured", category: "validation_failed" },
    });
    expect(unknownProvider.error?.message).toMatch(/Provider/);

    const unknownModel = await service.validate({ providerId: "openai", model: "nope" });
    expect(unknownModel).toMatchObject({
      ok: false,
      providerId: "openai",
      model: "nope",
      error: { code: "model_not_configured", category: "validation_failed" },
    });
    expect(unknownModel.error?.message).toContain("白名单");
    expect(calls).toHaveLength(0);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("distinguishes a missing credential from an unavailable credential bridge", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ choices: [] }));
    const service = makeService(fetchImpl);

    const missing = await service.validate({
      providerId: "missing-key",
      model: "missing-key-model",
    });
    expect(missing).toMatchObject({
      ok: false,
      supportsImage: true,
      upstreamStatus: null,
      error: { code: "credential_missing", category: "validation_failed" },
    });
    expect(missing.error?.message).toContain("API Key");

    const bridge = await service.validate({ providerId: "bridge-key", model: "bridge-model" });
    expect(bridge).toMatchObject({
      ok: false,
      error: { code: "credential_unavailable", category: "unavailable" },
    });
    expect(bridge.error?.message).toContain("凭据桥");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "provider_authentication_failed", "validation_failed"],
    [403, "provider_access_denied", "validation_failed"],
    [404, "model_not_found", "validation_failed"],
    [400, "model_invalid_request", "validation_failed"],
    [429, "provider_rate_limited", "unavailable"],
    [500, "provider_unavailable", "unavailable"],
    [503, "provider_unavailable", "unavailable"],
    [504, "provider_timeout", "unavailable"],
  ])("classifies HTTP %i as %s", async (status, code, category) => {
    const { fetchImpl, calls } = mockFetch(async () =>
      jsonResponse({ error: { message: "upstream detail" } }, status),
    );
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result).toMatchObject({
      ok: false,
      upstreamStatus: status,
      supportsImage: true,
      error: { code, category },
    });
    expect(result.error?.message).toMatch(/[\u4e00-\u9fff]/);
    expect(result.error?.message).not.toContain("upstream detail");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(calls).toHaveLength(1);
  });

  it("uses a bounded error-body hint to recognize a model rejection", async () => {
    const { fetchImpl } = mockFetch(async () =>
      jsonResponse({ error: { message: "The model `vision-model` does not exist" } }, 400),
    );
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result.error?.code).toBe("model_not_found");
    expect(result.error?.category).toBe("validation_failed");
  });

  it("classifies a connection failure as unavailable without leaking details", async () => {
    const { fetchImpl } = mockFetch(async () => {
      throw new TypeError(`fetch failed for Bearer ${SECRET}`);
    });
    const service = makeService(fetchImpl);

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result).toMatchObject({
      ok: false,
      upstreamStatus: null,
      error: { code: "provider_unreachable", category: "unavailable" },
    });
    expect(result.latencyMs).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("enforces the short timeout", async () => {
    const { fetchImpl } = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const service = makeService(fetchImpl, { timeoutMs: 20 });

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result).toMatchObject({
      ok: false,
      upstreamStatus: null,
      error: { code: "provider_timeout", category: "unavailable" },
    });
  });

  it("bounds the upstream response body", async () => {
    const { fetchImpl } = mockFetch(async () => new Response("x".repeat(2048), { status: 200 }));
    const service = makeService(fetchImpl, { maxResponseBytes: 64 });

    const result = await service.validate({ providerId: "openai", model: "vision-model" });

    expect(result).toMatchObject({
      ok: false,
      upstreamStatus: 200,
      error: { code: "provider_response_too_large", category: "unavailable" },
    });
  });

  it("rejects malformed request identifiers", async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse({ choices: [] }));
    const service = makeService(fetchImpl);

    await expect(service.validate({ providerId: 42 as unknown as string })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(service.validate({ model: "   " })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(calls).toHaveLength(0);
  });
});
