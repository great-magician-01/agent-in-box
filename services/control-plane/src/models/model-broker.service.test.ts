import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelBrokerService } from "./model-broker.service";
import { ModelProviderService } from "./model-provider.service";
import { ModelTokenService } from "./model-token.service";
import type { ModelCredentialProvider } from "./credential-provider";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";

let ctx: TestContext;
let upstream: Server;
let broker: ModelBrokerService;
let tokens: ModelTokenService;
let tasks: TaskService;
let workerId: string;
let token: { token: string; context: { id: string } };
let baseUrl: string;
const upstreamRequests: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  ctx = await createTestContext();
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy" })
    .where("id", "=", ctx.vmId)
    .execute();
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    upstreamRequests.push(body);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hello" } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      })}\n\n`,
    );
    if (JSON.stringify(body).includes("slow-stream")) {
      await delay(400);
      if (!response.destroyed) response.end("data: [DONE]\n\n");
      return;
    }
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const providers = new ModelProviderService(ctx.app.db);
  await providers.upsert("mock", {
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    api: "openai-completions",
    credentialProviderId: "mock-key",
    models: [{ id: "mock-cua", name: "Mock CUA" }],
    enabled: true,
  });
  const workers = new WorkerRepository(ctx.app.db);
  const worker = await workers.createWorker({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    conversationId: ctx.conversationId,
    engineType: "pi-rpc",
    engineVersion: "1.5.1",
    capabilitySet: ["computer_use"],
  });
  workerId = worker.id;
  tokens = new ModelTokenService(ctx.app.db, { ttlMs: 60_000 });
  tasks = new TaskService(
    ctx.app.db,
    new TaskRepository(ctx.app.db),
    new OutboxRepository(ctx.app.db),
    {},
  );
  const credentials: ModelCredentialProvider = {
    getSecret: async (providerId) =>
      providerId === "mock-key" ? "upstream-secret-value" : Promise.reject(new Error("missing")),
  };
  broker = new ModelBrokerService(ctx.app.db, tokens, providers, credentials, {
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 5000,
  });
  await broker.onModuleInit();
  baseUrl = `http://127.0.0.1:${broker.port}`;
  token = await tokens.issue({
    workerId,
    vmId: ctx.vmId,
    sessionId: "fake-session",
    providerId: "mock",
    model: "mock-cua",
  });
});

afterEach(async () => {
  await broker?.onModuleDestroy();
  upstream.close();
  await ctx.close();
  upstreamRequests.length = 0;
});

async function callBroker(
  body: Record<string, unknown>,
  bearer = token.token,
): Promise<{ status: number; text: string; contentType: string | null }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

async function drainOrTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<void> {
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error("stream was not interrupted")), timeoutMs),
  );
  const drain = (async () => {
    while (true) {
      try {
        const { done } = await reader.read();
        if (done) return;
      } catch {
        return;
      }
    }
  })();
  await Promise.race([drain, timeout]);
}

describe("ModelBrokerService", () => {
  it("forwards streaming bytes with the host-held key and records usage", async () => {
    const result = await callBroker({
      model: "mock-cua",
      stream: true,
      messages: [{ role: "user", content: "take a screenshot" }],
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    expect(result.text).toContain('"content":"hello"');
    expect(result.text).toContain("[DONE]");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({ model: "mock-cua", stream: true });

    const requests = await broker.listRequests({ workerId });
    expect(requests[0]).toMatchObject({
      status: "completed",
      providerId: "mock",
      model: "mock-cua",
      upstreamStatus: 200,
      usage: { inputTokens: 11, outputTokens: 4 },
    });
  });

  it("rejects a model outside the token whitelist without calling upstream", async () => {
    const result = await callBroker({ model: "other-model", messages: [] });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(upstreamRequests).toHaveLength(0);
  });

  it("blocks calls after the bound task is cancelled", async () => {
    const created = await tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      objective: "worker task",
      idempotencyKey: "broker-task-1",
    });
    const claimed = await tasks.claimNext(ctx.vmId, workerId);
    expect(claimed?.id).toBe(created.task.id);
    await tokens.bindTask(token.context.id, created.task.id);
    const allowed = await callBroker({ model: "mock-cua", messages: [] });
    expect(allowed.status).toBe(200);

    await tasks.cancel(created.task.id, "用户取消");
    const blocked = await callBroker({ model: "mock-cua", messages: [] });
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.text)).toMatchObject({ error: { code: "conflict" } });
    expect(upstreamRequests).toHaveLength(1);
  });

  it("interrupts an active stream when the token is revoked", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.token}`,
      },
      body: JSON.stringify({
        model: "mock-cua",
        stream: true,
        messages: [{ role: "user", content: "slow-stream" }],
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await tokens.revoke(token.context.id, "revoked_during_stream");
    await drainOrTimeout(reader, 3000);
    await waitFor(async () => {
      const requests = await broker.listRequests({ workerId });
      return requests[0]?.status === "cancelled";
    }, "cancelled broker request");
    const requests = await broker.listRequests({ workerId });
    expect(requests[0]).toMatchObject({
      status: "cancelled",
      errorCode: "request_revoked",
    });
  });

  it("rejects revoked and expired tokens", async () => {
    await tokens.revoke(token.context.id, "manual_revoke");
    const revoked = await callBroker({ model: "mock-cua", messages: [] });
    expect(revoked.status).toBe(401);
    expect(JSON.parse(revoked.text)).toMatchObject({ error: { code: "unauthorized" } });
    expect(upstreamRequests).toHaveLength(0);
  });
});
