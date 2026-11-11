import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { SupervisorVmState, VmPowerState } from "@agent-in-box/protocol";
import { nowIso } from "../persistence/time";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService, SETTINGS_KEYS } from "../settings/settings.service";
import type { SupervisorClient } from "../vms/supervisor.client";
import { ResourceManagerService } from "./resource-manager.service";

const GIB = 1024 ** 3;

function runtime(id: string, powerState: VmPowerState): SupervisorVmState {
  return {
    id,
    powerState,
    pid: powerState === "stopped" ? 0 : 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: 17611,
    workerHostPort: 17612,
    consoleUrl: "vnc://127.0.0.1:5900",
    diskPath: "/tmp/disk.qcow2",
    guestHealth: "unknown",
    lastError: "",
    updatedAt: nowIso(),
  };
}

interface Harness {
  ctx: TestContext;
  tasks: TaskService;
  settings: SettingsService;
  calls: string[];
  service: ResourceManagerService;
}

describe("ResourceManagerService", () => {
  let ctx: TestContext;
  let tasks: TaskService;
  let settings: SettingsService;
  let calls: string[];
  let service: ResourceManagerService;

  async function build(total = 16 * GIB, free = 8 * GIB): Promise<Harness> {
    ctx = await createTestContext();
    const outbox = new OutboxRepository(ctx.app.db);
    tasks = new TaskService(ctx.app.db, new TaskRepository(ctx.app.db), outbox);
    settings = new SettingsService(ctx.app.db);
    calls = [];
    const supervisor = {
      start: async (id: string) => {
        calls.push(`start:${id}`);
        await ctx.app.db
          .updateTable("vm_instances")
          .set({ power_state: "running" })
          .where("id", "=", id)
          .execute();
        return runtime(id, "running");
      },
      resume: async (id: string) => {
        calls.push(`resume:${id}`);
        await ctx.app.db
          .updateTable("vm_instances")
          .set({ power_state: "running" })
          .where("id", "=", id)
          .execute();
        return runtime(id, "running");
      },
      suspend: async (id: string) => {
        calls.push(`suspend:${id}`);
        await ctx.app.db
          .updateTable("vm_instances")
          .set({ power_state: "suspended" })
          .where("id", "=", id)
          .execute();
        return runtime(id, "suspended");
      },
    } as unknown as SupervisorClient;
    service = new ResourceManagerService(ctx.app.db, settings, supervisor, tasks, outbox, {
      totalMemoryBytes: () => total,
      freeMemoryBytes: () => free,
      autoTick: false,
      now: () => new Date("2026-11-11T12:00:00.000Z"),
    });
    return { ctx, tasks, settings, calls, service };
  }

  async function policy(overrides: Record<string, unknown>): Promise<void> {
    await settings.setJson(SETTINGS_KEYS.resourcePolicy, {
      hostReserveBytes: 2 * GIB,
      softMemoryBudgetBytes: 0,
      autoStartPolicy: "manual",
      idleSuspendEnabled: false,
      idleSuspendTimeoutMs: 60 * 60_000,
      ...overrides,
    });
  }

  async function createTask(objective: string): Promise<string> {
    const result = await tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective,
      idempotencyKey: `phase9:${objective}`,
    });
    return result.task.id;
  }

  beforeEach(async () => {
    await build();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("parks waiting tasks when the soft budget cannot auto-start their VM", async () => {
    await policy({ autoStartPolicy: "when_needed", softMemoryBudgetBytes: 1 * GIB });
    const taskId = await createTask("needs a VM");
    const result = await service.reconcile();
    expect(result.startedVmIds).toEqual([]);
    expect(result.waitingTaskIds).toContain(taskId);
    const task = await tasks.get(taskId);
    expect(task?.status).toBe("waiting_resources");
    expect(calls).toEqual([]);
    expect(result.report.blockedAutoStarts).toHaveLength(1);
    const events = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(events.some((event) => event.topic === "resource.waiting_for_memory")).toBe(true);
  });

  it("auto-starts a stopped VM once the budget allows and returns tasks to the queue", async () => {
    await policy({ autoStartPolicy: "when_needed", softMemoryBudgetBytes: 4 * GIB });
    const taskId = await createTask("auto start");
    const result = await service.reconcile();
    expect(result.startedVmIds).toEqual([ctx.vmId]);
    expect(calls).toContain(`start:${ctx.vmId}`);
    expect((await tasks.get(taskId))?.status).toBe("queued");
    const tasksInResourceReport = result.report.queuedTaskCount;
    expect(tasksInResourceReport).toBe(1);
    const events = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(events.some((event) => event.topic === "resource.vm_auto_started")).toBe(true);
  });

  it("auto-starts different VMs in parallel while the shared budget allows it", async () => {
    const catalog = new CatalogRepository(ctx.app.db);
    const image = await ctx.app.db.selectFrom("images").select("id").executeTakeFirstOrThrow();
    const secondProject = await catalog.createProject({ name: "Parallel project" });
    const secondVm = await catalog.createVm({
      name: "Parallel VM",
      imageId: image.id,
      osFamily: "linux",
      cpuCount: 1,
      memoryBytes: 2 * GIB,
      diskBytes: 10 * GIB,
      storageRoot: ctx.dir,
    });
    const secondConversation = await catalog.createConversation({
      kind: "project",
      projectId: secondProject.id,
      title: "Parallel conversation",
    });
    await catalog.bindVm({
      projectId: secondProject.id,
      vmId: secondVm.id,
      guestWorkspacePath: "/home/worker/parallel",
      isPrimary: true,
    });
    await policy({ autoStartPolicy: "when_needed", softMemoryBudgetBytes: 4 * GIB });
    const firstTask = await createTask("parallel first");
    const secondTaskResult = await tasks.create({
      projectId: secondProject.id,
      vmId: secondVm.id,
      originConversationId: secondConversation.id,
      objective: "parallel second",
      idempotencyKey: "phase9:parallel-second",
    });
    const result = await service.reconcile();
    expect(result.startedVmIds.sort()).toEqual([ctx.vmId, secondVm.id].sort());
    expect(calls).toEqual(expect.arrayContaining([`start:${ctx.vmId}`, `start:${secondVm.id}`]));
    expect((await tasks.get(firstTask))?.status).toBe("queued");
    expect((await tasks.get(secondTaskResult.task.id))?.status).toBe("queued");
    expect(result.report.runningVmCount).toBe(2);
  });

  it("never suspends a VM that still has an active task", async () => {
    await policy({ idleSuspendEnabled: true, idleSuspendTimeoutMs: 5 * 60_000 });
    await ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "running", last_started_at: "2026-11-11T10:00:00.000Z" })
      .where("id", "=", ctx.vmId)
      .execute();
    await createTask("still running");
    await ctx.app.db
      .updateTable("tasks")
      .set({ status: "running", started_at: nowIso() })
      .execute();
    await service.reconcile();
    expect(calls.filter((call) => call.startsWith("suspend:"))).toEqual([]);
  });

  it("suspends an idle running VM after the configured timeout", async () => {
    await policy({ idleSuspendEnabled: true, idleSuspendTimeoutMs: 5 * 60_000 });
    await ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "running", last_started_at: "2026-11-11T10:00:00.000Z" })
      .where("id", "=", ctx.vmId)
      .execute();
    const result = await service.reconcile();
    expect(result.suspendedVmIds).toEqual([ctx.vmId]);
    expect(calls).toContain(`suspend:${ctx.vmId}`);
    const events = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(events.some((event) => event.topic === "resource.vm_idle_suspended")).toBe(true);
  });

  it("resumes a suspended VM for waiting tasks when auto-start is enabled", async () => {
    await policy({ autoStartPolicy: "when_needed", softMemoryBudgetBytes: 4 * GIB });
    await ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "suspended" })
      .where("id", "=", ctx.vmId)
      .execute();
    const taskId = await createTask("resume me");
    const result = await service.reconcile();
    expect(result.resumedVmIds).toEqual([ctx.vmId]);
    expect(calls).toContain(`resume:${ctx.vmId}`);
    expect((await tasks.get(taskId))?.status).toBe("queued");
  });
});
