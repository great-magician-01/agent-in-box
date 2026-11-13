import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceError } from "../persistence/errors";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService } from "../settings/settings.service";
import { ModelProviderService } from "./model-provider.service";

let ctx: TestContext;
let providers: ModelProviderService;
let settings: SettingsService;

beforeEach(async () => {
  ctx = await createTestContext();
  settings = new SettingsService(ctx.app.db);
  providers = new ModelProviderService(ctx.app.db, settings);
  await providers.upsert("first", {
    baseUrl: "https://first.example.com/v1",
    api: "openai-completions",
    credentialProviderId: "first-key",
    models: [{ id: "first-model" }, { id: "first-alt" }],
  });
  await providers.upsert("second", {
    baseUrl: "https://second.example.com",
    api: "anthropic-messages",
    credentialProviderId: "second-key",
    models: [{ id: "second-model", reasoning: true }],
  });
});

afterEach(async () => {
  await ctx.close();
});

describe("ModelProviderService", () => {
  it("uses the first enabled provider when no selection is configured", async () => {
    const resolved = await providers.resolve(undefined, undefined, "worker");
    expect(resolved.provider.id).toBe("first");
    expect(resolved.model.id).toBe("first-model");
  });

  it("resolves separate Worker and Router selections from settings", async () => {
    await settings.updateModelSelection({
      worker: { providerId: "second", model: "second-model" },
      router: { providerId: "first", model: "first-alt" },
    });
    await expect(providers.resolve(undefined, undefined, "worker")).resolves.toMatchObject({
      provider: { id: "second" },
      model: { id: "second-model" },
    });
    await expect(providers.resolve(undefined, undefined, "router")).resolves.toMatchObject({
      provider: { id: "first" },
      model: { id: "first-alt" },
    });
  });

  it("lets an explicit selection override settings", async () => {
    await settings.updateModelSelection({
      worker: { providerId: "second", model: "second-model" },
    });
    const resolved = await providers.resolve("first", "first-alt", "worker");
    expect(resolved.provider.id).toBe("first");
    expect(resolved.model.id).toBe("first-alt");
  });

  it("rejects a selected provider that is disabled", async () => {
    await settings.updateModelSelection({
      worker: { providerId: "second", model: "second-model" },
    });
    await providers.upsert("second", {
      baseUrl: "https://second.example.com",
      api: "anthropic-messages",
      credentialProviderId: "second-key",
      models: [{ id: "second-model" }],
      enabled: false,
    });
    await expect(providers.resolve(undefined, undefined, "worker")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a model outside the provider whitelist", async () => {
    await expect(
      providers.validateSelection({ providerId: "first", model: "missing" }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it("stores model input modalities and rejects invalid declarations", async () => {
    await providers.upsert("multi", {
      baseUrl: "https://multi.example.com/v1",
      api: "openai-completions",
      credentialProviderId: "multi-key",
      models: [
        { id: "text-only", input: ["text"] },
        { id: "vision", input: ["text", "image"] },
      ],
    });
    await expect(providers.resolve("multi", "text-only", "worker")).resolves.toMatchObject({
      model: { id: "text-only", input: ["text"] },
    });
    await expect(
      providers.upsert("bad", {
        baseUrl: "https://bad.example.com/v1",
        api: "openai-completions",
        credentialProviderId: "bad-key",
        models: [{ id: "image-only", input: ["image"] }],
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
