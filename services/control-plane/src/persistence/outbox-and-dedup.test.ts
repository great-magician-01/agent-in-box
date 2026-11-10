import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventDedupRepository } from "./repositories/event-dedup-repository";
import { OutboxRepository } from "./repositories/outbox-repository";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;
let outbox: OutboxRepository;
let dedup: EventDedupRepository;

beforeEach(async () => {
  ctx = await createTestContext();
  outbox = new OutboxRepository(ctx.app.db);
  dedup = new EventDedupRepository(ctx.app.db);
});

afterEach(async () => {
  await ctx.close();
});

describe("outbox", () => {
  it("marks messages published and records failures", async () => {
    const at = "2026-11-10T00:00:00.000Z";
    await outbox.append("task.created", { taskId: "task-a" }, at);
    await outbox.append("task.status_changed", { taskId: "task-a", to: "queued" }, at);

    const pending = await outbox.listPending();
    expect(pending).toHaveLength(2);

    await outbox.markPublished([pending[0]!.id], at);
    expect(await outbox.listPending()).toHaveLength(1);

    await outbox.markFailed(pending[1]!.id, "dispatcher unavailable");
    const remaining = await outbox.listPending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.attempts).toBe(1);
    expect(remaining[0]!.lastError).toBe("dispatcher unavailable");
  });
});

describe("event deduplication", () => {
  it("claims an event exactly once", async () => {
    expect(await dedup.claim("feishu:device-1:event-1", "2026-11-10T00:00:00.000Z")).toBe(true);
    expect(await dedup.claim("feishu:device-1:event-1", "2026-11-10T00:00:01.000Z")).toBe(false);
    expect(await dedup.isProcessed("feishu:device-1:event-1")).toBe(true);
    expect(await dedup.isProcessed("feishu:device-1:event-2")).toBe(false);
  });
});
