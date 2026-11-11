import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { WorkerRegistryService } from "../workers/worker-registry.service";
import type { WorkerRuntimeService } from "../workers/worker-runtime.service";
import { RouterToolBrokerService } from "./router-tool-broker.service";
import { RouterToolService } from "./router-tool.service";

interface Harness {
  ctx: TestContext;
  broker: RouterToolBrokerService;
  token: string;
  conversationId: string;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await harness.broker.onModuleDestroy();
    await harness.ctx.close();
  }
});

async function createHarness(): Promise<Harness> {
  const ctx = await createTestContext();
  const outbox = new OutboxRepository(ctx.app.db);
  const tasks = new TaskService(ctx.app.db, new TaskRepository(ctx.app.db), outbox);
  const workers = new WorkerRepository(ctx.app.db);
  const archives = new WorkerArchiveRepository(ctx.app.db);
  const registry = new WorkerRegistryService(ctx.app.db, workers, archives, tasks, outbox);
  const tools = new RouterToolService(
    ctx.app.db,
    tasks,
    registry,
    {} as unknown as WorkerRuntimeService,
  );
  const conversationId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  await ctx.app.db
    .insertInto("conversations")
    .values({
      id: conversationId,
      kind: "router",
      project_id: null,
      title: "Router",
      created_at: now,
      last_message_at: now,
    })
    .execute();
  await ctx.app.db
    .insertInto("router_sessions")
    .values({
      conversation_id: conversationId,
      status: "running",
      session_ref: null,
      engine_type: "pi-rpc",
      engine_version: "1.5.1",
      session_version: "1",
      provider_id: "mock",
      model_id: "mock-model",
      tool_token_hash: createHash("sha256").update(token).digest("hex"),
      tool_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      last_active_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const broker = new RouterToolBrokerService(ctx.app.db, tools, outbox, { port: 0 });
  await broker.onModuleInit();
  return { ctx, broker, token, conversationId };
}

describe("RouterToolBrokerService", () => {
  it("authenticates a Router tool token and audits every call", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const listed = await fetch(`http://127.0.0.1:${harness.broker.port}/v1/tools`, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    expect(listed.status).toBe(200);
    const listPayload = (await listed.json()) as {
      ok: boolean;
      result: Array<{ name: string }>;
    };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.result.map((tool) => tool.name)).toContain("create_task");

    const response = await fetch(`http://127.0.0.1:${harness.broker.port}/v1/tools/list_projects`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      result: Array<{ projectId: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.result[0]?.projectId).toBe(harness.ctx.projectId);
    const calls = await harness.ctx.app.db
      .selectFrom("router_tool_calls")
      .selectAll()
      .where("conversation_id", "=", harness.conversationId)
      .execute();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_name: "list_projects", status: "ok" });
  });

  it("rejects missing, expired and unknown tool access", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const unauthorized = await fetch(
      `http://127.0.0.1:${harness.broker.port}/v1/tools/list_projects`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();

    const unknown = await fetch(
      `http://127.0.0.1:${harness.broker.port}/v1/tools/delete_everything`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(unknown.status).toBe(404);
    await unknown.arrayBuffer();
    const errors = await harness.ctx.app.db
      .selectFrom("router_tool_calls")
      .selectAll()
      .where("status", "=", "error")
      .execute();
    expect(errors[0]).toMatchObject({
      tool_name: "delete_everything",
      error_code: "not_found",
    });

    await harness.ctx.app.db
      .updateTable("router_sessions")
      .set({ tool_token_expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("conversation_id", "=", harness.conversationId)
      .execute();
    const expired = await fetch(`http://127.0.0.1:${harness.broker.port}/v1/tools/list_projects`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(expired.status).toBe(401);
    await expired.arrayBuffer();
  });
});
