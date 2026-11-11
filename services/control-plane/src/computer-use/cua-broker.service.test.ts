import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { CuaBrokerService } from "./cua-broker.service";
import type { CuaExecutionService } from "./cua-execution.service";
import { CuaTokenService } from "./cua-token.service";

interface Harness {
  ctx: TestContext;
  broker: CuaBrokerService;
  token: string;
  calls: unknown[];
}

let harness: Harness | null = null;

beforeEach(async () => {
  const ctx = await createTestContext();
  const workers = new WorkerRepository(ctx.app.db);
  const worker = await workers.createWorker({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    conversationId: ctx.conversationId,
    engineType: "pi-rpc",
    engineVersion: "1.5.1",
    capabilitySet: ["computer_use"],
  });
  const tokens = new CuaTokenService(ctx.app.db, { ttlMs: 60_000 });
  const issued = await tokens.issue({
    workerId: worker.id,
    vmId: ctx.vmId,
    sessionId: "broker-session",
    taskId: null,
  });
  const calls: unknown[] = [];
  const execution = {
    observe: async (token: unknown, input: unknown) => {
      calls.push({ route: "observe", token, input });
      return {
        taskId: "broker-task",
        screenshotId: "observation-1",
        width: 800,
        height: 600,
        dpi: 96,
        scaleFactor: 1,
        sha256: "a".repeat(64),
        dataBase64: Buffer.from("png").toString("base64"),
      };
    },
    act: async (token: unknown, input: unknown) => {
      calls.push({ route: "act", token, input });
      return {
        taskId: "broker-task",
        actionId: "action-1",
        status: "executed",
        ok: true,
        screenshotId: "after-1",
        afterScreenshot: {
          screenshotId: "after-1",
          width: 800,
          height: 600,
          dpi: 96,
          scaleFactor: 1,
          dataBase64: Buffer.from("png2").toString("base64"),
        },
      };
    },
    complete: async (token: unknown, input: unknown) => {
      calls.push({ route: "complete", token, input });
      return { taskId: "broker-task", completed: true, evidence: [] };
    },
  } as unknown as CuaExecutionService;
  const broker = new CuaBrokerService(tokens, execution, { port: 0 });
  await broker.onModuleInit();
  harness = { ctx, broker, token: issued.token, calls };
});

afterEach(async () => {
  await harness?.broker.onModuleDestroy();
  await harness?.ctx.close();
  harness = null;
});

describe("CuaBrokerService", () => {
  it("requires a scoped bearer token on every Computer Use route", async () => {
    const h = harness!;
    const response = await fetch(`http://127.0.0.1:${h.broker.port}/v1/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
    expect(h.calls).toHaveLength(0);
  });

  it("serves observe, action and complete responses with screenshot images", async () => {
    const h = harness!;
    const observe = await fetch(`http://127.0.0.1:${h.broker.port}/v1/observe`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(observe.status).toBe(200);
    const observed = (await observe.json()) as {
      screenshotId: string;
      image: { dataBase64: string; mimeType: string };
    };
    expect(observed.screenshotId).toBe("observation-1");
    expect(observed.image.mimeType).toBe("image/png");

    const action = await fetch(`http://127.0.0.1:${h.broker.port}/v1/actions`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        action: { type: "click", point: { x: 1, y: 2 } },
        screenshotId: "observation-1",
      }),
    });
    expect(action.status).toBe(200);
    const acted = (await action.json()) as { screenshotId: string; actionId: string };
    expect(acted).toMatchObject({ screenshotId: "after-1", actionId: "action-1" });

    const complete = await fetch(`http://127.0.0.1:${h.broker.port}/v1/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: "done",
        evidence: [{ type: "file", path: "/home/worker/workspace/a.txt" }],
      }),
    });
    expect(complete.status).toBe(200);
    const completed = (await complete.json()) as { completed: boolean };
    expect(completed.completed).toBe(true);
    expect(h.calls.map((call) => (call as { route: string }).route)).toEqual([
      "observe",
      "act",
      "complete",
    ]);
  });

  it("rejects malformed JSON bodies", async () => {
    const h = harness!;
    const malformed = await fetch(`http://127.0.0.1:${h.broker.port}/v1/observe`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.arrayBuffer();
  });
});
