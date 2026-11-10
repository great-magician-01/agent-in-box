import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseConflictError } from "./errors";
import { LeaseRepository } from "./repositories/lease-repository";
import { LeaseService } from "./services/lease-service";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;
let service: LeaseService;

beforeEach(async () => {
  ctx = await createTestContext();
  service = new LeaseService(ctx.app.db, new LeaseRepository(ctx.app.db));
});

afterEach(async () => {
  await ctx.close();
});

describe("LeaseService", () => {
  it("allows exactly one active execution lease per VM", async () => {
    const now = new Date("2026-11-10T00:00:00.000Z");

    const first = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      now,
      ttlMs: 30_000,
    });

    const sameRequest = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      now,
      ttlMs: 30_000,
    });
    expect(sameRequest.id).toBe(first.id);

    await expect(
      service.acquire({
        vmId: ctx.vmId,
        owner: "worker",
        taskId: "task-b",
        now,
        ttlMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
  });

  it("replaces an expired lease and allows a different task", async () => {
    const start = new Date("2026-11-10T00:00:00.000Z");
    const first = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      now: start,
      ttlMs: 10_000,
    });

    const later = new Date("2026-11-10T00:00:11.000Z");
    const second = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-b",
      now: later,
      ttlMs: 10_000,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.taskId).toBe("task-b");
  });

  it("releases and renews leases", async () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    const lease = await service.acquire({
      vmId: ctx.vmId,
      owner: "human",
      taskId: null,
      now,
      ttlMs: 10_000,
    });

    const renewed = await service.renew(lease.id, 20_000, now);
    expect(new Date(renewed.expiresAt).getTime()).toBe(now.getTime() + 20_000);

    expect(await service.release(ctx.vmId, lease.id)).toBe(true);
    expect(await service.getActive(ctx.vmId, now)).toBeUndefined();
  });

  it("does not release a lease through the wrong VM", async () => {
    const lease = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
    });

    expect(await service.release("other-vm", lease.id)).toBe(false);
  });
});
