import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestActionRequest } from "@agent-in-box/protocol";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import type { GuestClient } from "./guest.client";
import { GuestService } from "./guest.service";
import type { SupervisorClient } from "./supervisor.client";
import type { VmService } from "./vm.service";

describe("GuestService execution control", () => {
  let ctx: TestContext;
  let leases: LeaseService;
  let input: ReturnType<typeof vi.fn>;
  let service: GuestService;
  let powerState: "running" | "stopped";

  beforeEach(async () => {
    ctx = await createTestContext();
    leases = new LeaseService(ctx.app.db, new LeaseRepository(ctx.app.db));
    input = vi.fn(async () => ({
      actionId: "action-1",
      ok: true,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    }));
    powerState = "running";
    service = new GuestService(
      { getRecord: async () => ({ storageRoot: ctx.dir }) } as unknown as VmService,
      {
        get: async () => ({ powerState, guestHostPort: 17611 }),
      } as unknown as SupervisorClient,
      leases,
      { input } as unknown as GuestClient,
    );
  });

  afterEach(async () => ctx.close());

  it("executes AI input only with the current worker Lease", async () => {
    const worker = await leases.acquire({ vmId: ctx.vmId, owner: "worker", taskId: "task-a" });
    const request: GuestActionRequest = {
      leaseId: worker.id,
      actionId: "action-1",
      action: { type: "click", point: { x: 10, y: 20 } },
      timeoutMs: 5_000,
    };
    await expect(service.input(ctx.vmId, request)).resolves.toMatchObject({ ok: true });
    expect(input).toHaveBeenCalledOnce();

    await leases.acquire({ vmId: ctx.vmId, owner: "human", taskId: null });
    await expect(service.input(ctx.vmId, request)).rejects.toMatchObject({
      code: "lease_conflict",
    });
    expect(input).toHaveBeenCalledOnce();
  });

  it("does not send input to a stopped guest even with a valid Lease", async () => {
    const worker = await leases.acquire({ vmId: ctx.vmId, owner: "worker", taskId: "task-a" });
    powerState = "stopped";
    await expect(
      service.input(ctx.vmId, { leaseId: worker.id, action: { type: "wait", milliseconds: 1 } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(input).not.toHaveBeenCalled();
  });
});
