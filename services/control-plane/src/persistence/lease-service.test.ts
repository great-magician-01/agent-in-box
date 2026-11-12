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

  it("lets human takeover revoke AI input and rejects workers until released", async () => {
    const worker = await service.acquire({ vmId: ctx.vmId, owner: "worker", taskId: "task-a" });
    const human = await service.acquire({ vmId: ctx.vmId, owner: "human", taskId: null });

    expect(human.id).not.toBe(worker.id);
    expect((await service.control(ctx.vmId)).state).toBe("human");
    await expect(
      service.executeWithLease(ctx.vmId, worker.id, "worker", async () => "unexpected"),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await expect(
      service.acquire({ vmId: ctx.vmId, owner: "worker", taskId: "task-a" }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await expect(
      service.executeWithLease(ctx.vmId, human.id, "human", async () => "input"),
    ).resolves.toBe("input");
    expect(await service.release(ctx.vmId, human.id)).toBe(true);
    expect((await service.control(ctx.vmId)).state).toBe("idle");
  });

  it("does not renew or replay actions through an expired lease", async () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    const lease = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      now,
      ttlMs: 1_000,
    });
    await expect(
      service.renew(lease.id, 30_000, new Date(now.getTime() + 1_001)),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    await expect(
      service.executeWithLease(ctx.vmId, lease.id, "worker", async () => "unexpected"),
    ).rejects.toBeInstanceOf(LeaseConflictError);
  });

  it("does not shorten a worker lease when a heartbeat uses a smaller default TTL", async () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    const lease = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      now,
      ttlMs: 30_000,
    });
    const renewed = await service.renew(lease.id, 15_000, new Date(now.getTime() + 1_000));
    expect(renewed.expiresAt).toBe(lease.expiresAt);
  });

  it("renews a lease while a long input holds the VM input lock", async () => {
    const lease = await service.acquire({
      vmId: ctx.vmId,
      owner: "worker",
      taskId: "task-a",
      ttlMs: 30_000,
    });
    let finishInput!: () => void;
    let markInputStarted!: () => void;
    const inputStarted = new Promise<void>((resolve) => {
      markInputStarted = resolve;
    });
    const input = service.executeWithLease(ctx.vmId, lease.id, "worker", async () => {
      markInputStarted();
      await new Promise<void>((resolve) => {
        finishInput = resolve;
      });
    });
    await inputStarted;
    try {
      const renewed = await Promise.race([
        service.renewForVm(ctx.vmId, lease.id, 30_000),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      expect(renewed).not.toBeNull();
      expect(Date.parse(renewed!.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
    } finally {
      finishInput();
      await input;
    }
  });

  it("serializes input operations that use the same active worker lease", async () => {
    const lease = await service.acquire({ vmId: ctx.vmId, owner: "worker", taskId: "task-a" });
    const events: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = service.executeWithLease(ctx.vmId, lease.id, "worker", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      events.push("first:end");
    });
    const second = service.executeWithLease(ctx.vmId, lease.id, "worker", async () => {
      events.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["first:start"]);
    finishFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
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
