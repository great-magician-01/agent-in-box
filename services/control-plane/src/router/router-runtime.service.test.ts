import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkerEngine,
  WorkerEngineEvent,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type { DatabaseService } from "../persistence/database.service";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService } from "../settings/settings.service";
import { ModelBrokerService } from "../models/model-broker.service";
import { ModelProviderService } from "../models/model-provider.service";
import { ModelTokenService } from "../models/model-token.service";
import { WorkerRegistryService } from "../workers/worker-registry.service";
import type { WorkerRuntimeService } from "../workers/worker-runtime.service";
import { RouterRuntimeService } from "./router-runtime.service";
import type { RouterToolBrokerService } from "./router-tool-broker.service";
import { RouterToolService } from "./router-tool.service";

class FakeRouterEngine implements WorkerEngine {
  readonly type = "pi-rpc";
  readonly specs: WorkerSessionSpec[] = [];
  readonly prompts: string[] = [];
  readonly resumeRefs: string[] = [];
  startCalls = 0;
  abortCalls = 0;
  disposeCalls = 0;
  resumeError: Error | null = null;
  private listener: ((event: WorkerEngineEvent) => void) | null = null;
  private hold = false;

  async startSession(spec: WorkerSessionSpec): Promise<WorkerSessionHandle> {
    this.startCalls += 1;
    this.specs.push(spec);
    return {
      sessionId: "router-session",
      archiveRef: "/router/sessions/router-session.jsonl",
      engineVersion: "1.5.1",
      sessionVersion: "1",
    };
  }

  async resume(archiveRef: string, spec?: WorkerSessionSpec): Promise<WorkerSessionHandle> {
    this.resumeRefs.push(archiveRef);
    if (spec) this.specs.push(spec);
    if (this.resumeError) throw this.resumeError;
    return {
      sessionId: "router-resumed",
      archiveRef,
      engineVersion: "1.5.1",
      sessionVersion: "1",
      mode: "native",
    };
  }

  async prompt(_sessionId: string, input: WorkerInput): Promise<void> {
    this.prompts.push(input.text);
    this.hold = input.text.startsWith("[hold]");
    this.emit({ type: "text_delta", delta: "Router reply" });
    if (!this.hold) setTimeout(() => this.emit({ type: "turn_finished" }), 5);
  }

  async steer(): Promise<"queued" | "handled"> {
    return "queued";
  }

  async followUp(): Promise<"queued" | "handled"> {
    return "queued";
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.emit({ type: "turn_finished" });
  }

  subscribe(_sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async archive(): Promise<{ archiveRef: string; summary: string }> {
    return { archiveRef: "/router/archive.jsonl", summary: "archived" };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  emit(event: WorkerEngineEvent): void {
    this.listener?.(event);
  }
}

interface Harness {
  ctx: TestContext;
  service: RouterRuntimeService;
  engine: FakeRouterEngine;
  tokens: ModelTokenService;
}

const harnesses: Array<{ ctx: TestContext; service: RouterRuntimeService }> = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const item = harnesses.pop()!;
    item.service.onModuleDestroy();
    await item.ctx.close();
  }
});

async function createHarness(
  options: { ctx?: TestContext; withProvider?: boolean; turnTimeoutMs?: number } = {},
): Promise<Harness> {
  const ctx = options.ctx ?? (await createTestContext());
  const outbox = new OutboxRepository(ctx.app.db);
  const taskRepository = new TaskRepository(ctx.app.db);
  const tasks = new TaskService(ctx.app.db, taskRepository, outbox);
  const workers = new WorkerRepository(ctx.app.db);
  const archives = new WorkerArchiveRepository(ctx.app.db);
  const registry = new WorkerRegistryService(ctx.app.db, workers, archives, tasks, outbox);
  const tools = new RouterToolService(
    ctx.app.db,
    tasks,
    registry,
    {} as unknown as WorkerRuntimeService,
  );
  const settings = new SettingsService(ctx.app.db);
  const providers = new ModelProviderService(ctx.app.db, settings);
  if (options.withProvider !== false) {
    await providers.upsert("mock", {
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      credentialProviderId: "mock",
      models: [{ id: "router-model", name: "Router Model" }],
      enabled: true,
    });
  }
  const tokens = new ModelTokenService(ctx.app.db, {
    ttlMs: 60_000,
    routerTtlMs: 60_000,
  });
  await tokens.onModuleInit();
  const engine = new FakeRouterEngine();
  const service = new RouterRuntimeService(
    ctx.app.db,
    { layout: { root: ctx.dir } } as DatabaseService,
    providers,
    tokens,
    { port: 6719 } as ModelBrokerService,
    { port: 6721 } as RouterToolBrokerService,
    tools,
    outbox,
    {
      dataRoot: ctx.dir,
      connectionFactory: () => engine,
      toolTokenTtlMs: 60_000,
      ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    },
    settings,
  );
  await service.onModuleInit();
  harnesses.push({ ctx, service });
  return { ctx, service, engine, tokens };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("RouterRuntimeService", () => {
  it("persists a Router turn and exposes only structured tools", async () => {
    const harness = await createHarness();
    const sent = await harness.service.send("Plan a report task");
    expect(sent.status).toBe("running");
    expect(sent.message.role).toBe("user");
    await waitFor(
      async () => (await harness.service.view()).status === "idle",
      "router idle after turn",
    );
    expect(harness.engine.prompts).toEqual(["Plan a report task"]);
    expect(harness.engine.specs[0]?.capabilities).toEqual([]);
    expect(harness.engine.specs[0]?.modelBroker?.baseUrl).toBe("http://127.0.0.1:6719");
    const messages = await harness.service.messages();
    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Plan a report task",
      "assistant:Router reply",
    ]);
    const view = await harness.service.view();
    expect(view.providerId).toBe("mock");
    expect(view.modelId).toBe("router-model");
    expect(view.messageCount).toBe(2);
    expect(view.tools.map((tool) => tool.name)).toContain("create_task");
    expect(view.tools.some((tool) => /shell|vm_input|supervisor/i.test(tool.name))).toBe(false);

    const rows = await harness.ctx.app.db.selectFrom("router_model_tokens").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toHaveLength(64);
    const extension = await harness.ctx.app.db
      .selectFrom("router_sessions")
      .select(["tool_token_hash"])
      .executeTakeFirst();
    expect(extension?.tool_token_hash).toHaveLength(64);
  });

  it("switches the Router model only when idle and starts a fresh session", async () => {
    const harness = await createHarness();
    const settings = new SettingsService(harness.ctx.app.db);
    const providers = new ModelProviderService(harness.ctx.app.db, settings);
    await providers.upsert("other", {
      baseUrl: "https://other.example.test/v1",
      api: "anthropic-messages",
      credentialProviderId: "other",
      models: [{ id: "other-model", reasoning: true }],
      enabled: true,
    });

    await harness.service.send("First turn");
    await waitFor(
      async () => (await harness.service.view()).status === "idle",
      "router idle before switch",
    );
    const firstView = await harness.service.view();
    expect(firstView.selectionSource).toBe("default");
    expect(firstView.selectedProviderId).toBe("mock");

    const switched = await harness.service.configure({
      providerId: "other",
      model: "other-model",
    });
    expect(switched.providerId).toBeNull();
    expect(switched.selectedProviderId).toBe("other");
    expect(switched.selectedModelId).toBe("other-model");
    expect(switched.selectionSource).toBe("settings");
    expect(harness.engine.disposeCalls).toBe(1);
    const row = await harness.ctx.app.db
      .selectFrom("router_sessions")
      .select(["session_ref", "provider_id", "model_id"])
      .executeTakeFirst();
    expect(row).toMatchObject({ session_ref: null, provider_id: null, model_id: null });

    await harness.service.send("Second turn");
    await waitFor(
      async () => (await harness.service.view()).status === "idle",
      "router idle after switch",
    );
    expect(harness.engine.startCalls).toBe(2);
    expect(harness.engine.specs[1]?.provider).toBe("other");
    expect(harness.engine.specs[1]?.model).toBe("other-model");
    expect(harness.engine.specs[1]?.modelBroker?.api).toBe("anthropic-messages");
    const saved = await settings.modelSelection();
    expect(saved.router).toEqual({ providerId: "other", model: "other-model" });
  });

  it("rejects a Router model switch while a turn is running", async () => {
    const harness = await createHarness();
    await harness.service.send("[hold] Long turn");
    await waitFor(
      async () => (await harness.service.view()).status === "running",
      "router running",
    );
    await expect(
      harness.service.configure({ providerId: "mock", model: "router-model" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await harness.service.abort();
  });

  it("rejects a concurrent turn and aborts cleanly", async () => {
    const harness = await createHarness();
    await harness.service.send("[hold] Long router turn");
    await waitFor(
      async () => (await harness.service.view()).status === "running",
      "router running",
    );
    await expect(harness.service.send("second")).rejects.toMatchObject({ code: "conflict" });
    const aborted = await harness.service.abort();
    expect(aborted.status).toBe("idle");
    expect(harness.engine.abortCalls).toBe(1);
    const messages = await harness.service.messages();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("resumes the persisted Router session after a restart", async () => {
    const harness = await createHarness();
    await harness.service.send("First router turn");
    await waitFor(async () => (await harness.service.view()).status === "idle", "router idle");
    harness.service.onModuleDestroy();
    harnesses.pop();
    const restarted = await createHarness({ ctx: harness.ctx });
    await restarted.service.send("Second router turn");
    await waitFor(
      async () => (await restarted.service.view()).status === "idle",
      "router idle after resume",
    );
    expect(restarted.engine.resumeRefs).toEqual(["/router/sessions/router-session.jsonl"]);
    const messages = await restarted.service.messages();
    expect(messages.map((message) => message.content)).toEqual([
      "First router turn",
      "Router reply",
      "Second router turn",
      "Router reply",
    ]);
  });

  it("clears an incompatible Router session and starts a recovered session with transcript context", async () => {
    const harness = await createHarness();
    await harness.service.send("First turn before incompatibility");
    await waitFor(async () => (await harness.service.view()).status === "idle", "router idle");
    harness.service.onModuleDestroy();
    harnesses.pop();
    const restarted = await createHarness({ ctx: harness.ctx });
    restarted.engine.resumeError = new Error("incompatible session format");
    await expect(restarted.service.send("Retry after incompatibility")).rejects.toMatchObject({
      code: "unavailable",
    });
    const row = await harness.ctx.app.db
      .selectFrom("router_sessions")
      .select(["session_ref", "status"])
      .executeTakeFirstOrThrow();
    expect(row.session_ref).toBeNull();
    restarted.engine.resumeError = null;
    await restarted.service.send("Recovered fresh session");
    await waitFor(
      async () => (await restarted.service.view()).status === "idle",
      "recovered router idle",
    );
    expect(restarted.engine.startCalls).toBeGreaterThanOrEqual(1);
    expect(restarted.engine.specs.at(-1)?.systemPrompt).toContain("Recovered Router conversation");
    expect(restarted.engine.specs.at(-1)?.systemPrompt).toContain(
      "First turn before incompatibility",
    );
  });

  it("aborts a Router turn that exceeds the maximum duration", async () => {
    const harness = await createHarness({ turnTimeoutMs: 1000 });
    await harness.service.send("[hold] stuck router turn");
    await waitFor(
      async () => (await harness.service.view()).status === "failed",
      "router timeout failure",
      4000,
    );
    expect(harness.engine.abortCalls).toBe(1);
    expect((await harness.service.view()).lastError).toContain("超过最大时长");
  }, 10_000);

  it("fails clearly when no model Provider is configured", async () => {
    const harness = await createHarness({ withProvider: false });
    await expect(harness.service.send("hello")).rejects.toMatchObject({
      code: "validation_failed",
    });
    const view = await harness.service.view();
    expect(view.status).toBe("failed");
    expect(view.lastError).toContain("未配置可用的模型 Provider");
  });
});
