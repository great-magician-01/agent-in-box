import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupervisorVmState, VmPowerState } from "@agent-in-box/protocol";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { nowIso } from "../persistence/time";
import { SnapshotService } from "./snapshot.service";
import type { SupervisorClient } from "./supervisor.client";

function runtime(id: string, powerState: VmPowerState): SupervisorVmState {
  return {
    id,
    powerState,
    pid: powerState === "stopped" ? 0 : 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: 17611,
    workerHostPort: 17612,
    consoleUrl: "vnc://127.0.0.1:5901",
    diskPath: "/tmp/disk.qcow2",
    guestHealth: "unknown",
    lastError: "",
    updatedAt: nowIso(),
  };
}

describe("SnapshotService", () => {
  let ctx: TestContext;
  let service: SnapshotService;
  let powerState: VmPowerState;
  let calls: string[];

  beforeEach(async () => {
    ctx = await createTestContext();
    powerState = "stopped";
    calls = [];
    const supervisor = {
      get: async (id: string) => runtime(id, powerState),
      createSnapshot: async (id: string, tag: string) => {
        calls.push(`create:${id}:${tag}`);
        return runtime(id, powerState);
      },
      restoreSnapshot: async (id: string, tag: string) => {
        calls.push(`restore:${id}:${tag}`);
        return runtime(id, powerState);
      },
    } as unknown as SupervisorClient;
    service = new SnapshotService(ctx.app.db, supervisor, new OutboxRepository(ctx.app.db));
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function bindSecondProject(): Promise<string> {
    const catalog = new CatalogRepository(ctx.app.db);
    const project = await catalog.createProject({ name: "Second shared project" });
    await catalog.bindVm({
      projectId: project.id,
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/other",
      isPrimary: true,
    });
    return project.id;
  }

  it("lists every bound project before restoring a shared VM snapshot", async () => {
    const secondProjectId = await bindSecondProject();
    const snapshot = await service.create(ctx.vmId, { label: "before shared work" });
    expect(snapshot.affectedProjects).toHaveLength(2);
    expect(calls[0]?.startsWith(`create:${ctx.vmId}:`)).toBe(true);

    const impact = await service.impact(ctx.vmId, snapshot.id);
    expect(impact.affectedProjects.map((project) => project.id).sort()).toEqual(
      [ctx.projectId, secondProjectId].sort(),
    );
    expect(impact.requiresConfirmation).toBe(true);
    expect(impact.warning).toContain("2 个项目");

    await expect(service.restore(ctx.vmId, snapshot.id)).rejects.toMatchObject({
      code: "conflict",
    });
    const restored = await service.restore(ctx.vmId, snapshot.id, {
      confirmSharedImpact: true,
    });
    expect(restored.blocked).toBe(false);
    expect(calls.some((call) => call.startsWith(`restore:${ctx.vmId}:`))).toBe(true);
    const events = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(events.some((event) => event.topic === "vm.snapshot_restored")).toBe(true);
  });

  it("refuses to create or restore while the VM is running or has an active task", async () => {
    powerState = "running";
    await expect(service.create(ctx.vmId)).rejects.toMatchObject({ code: "conflict" });
    powerState = "stopped";
    const snapshot = await service.create(ctx.vmId, { label: "stopped" });

    powerState = "running";
    await expect(service.restore(ctx.vmId, snapshot.id)).rejects.toMatchObject({
      code: "conflict",
    });

    powerState = "stopped";
    await ctx.app.db
      .insertInto("tasks")
      .values({
        id: "blocking-task",
        project_id: ctx.projectId,
        vm_id: ctx.vmId,
        origin_conversation_id: ctx.conversationId,
        assigned_worker_id: null,
        parent_task_id: null,
        objective: "block snapshot",
        status: "running",
        priority: 0,
        latest_summary: null,
        error_code: null,
        created_at: nowIso(),
        started_at: nowIso(),
        completed_at: null,
      })
      .execute();
    const impact = await service.impact(ctx.vmId, snapshot.id);
    expect(impact.blocked).toBe(true);
    await expect(
      service.restore(ctx.vmId, snapshot.id, { confirmSharedImpact: true }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("marks a failed provider snapshot as failed instead of available", async () => {
    const failing = new SnapshotService(
      ctx.app.db,
      {
        get: async (id: string) => runtime(id, "stopped"),
        createSnapshot: async () => {
          throw new Error("qemu-img failed");
        },
      } as unknown as SupervisorClient,
      new OutboxRepository(ctx.app.db),
    );
    await expect(failing.create(ctx.vmId)).rejects.toMatchObject({ code: "unavailable" });
    const rows = await ctx.app.db.selectFrom("vm_snapshots").selectAll().execute();
    expect(rows[0]?.status).toBe("failed");
  });
});
