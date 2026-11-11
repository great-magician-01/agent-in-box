import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { notificationForEvent } from "./notification-mapper";
import { NotificationsService } from "./notifications.service";

let ctx: TestContext;
let service: NotificationsService;
let tasks: TaskService;

beforeEach(async () => {
  ctx = await createTestContext();
  const outbox = new OutboxRepository(ctx.app.db);
  tasks = new TaskService(ctx.app.db, new TaskRepository(ctx.app.db), outbox);
  service = new NotificationsService(ctx.app.db, outbox, {
    pollIntervalMs: 60 * 60_000,
  });
  await service.onModuleInit();
});

afterEach(async () => {
  service.onModuleDestroy();
  await ctx.close();
});

async function createTask(key: string) {
  return tasks.create({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    originConversationId: ctx.conversationId,
    objective: `通知测试任务 ${key}`,
    idempotencyKey: key,
  });
}

describe("NotificationsService", () => {
  it("projects new durable events once and tracks read/dismiss state", async () => {
    await createTask("notification-task");
    expect(await service.reconcile()).toBe(1);
    expect(await service.reconcile()).toBe(0);

    const center = await service.center();
    expect(center.items).toHaveLength(1);
    expect(center.unreadCount).toBe(1);
    expect(center.items[0]?.kind).toBe("task");
    expect(center.items[0]?.title).toContain("新任务");

    const read = await service.markRead(center.items[0]!.id);
    expect(read.readAt).not.toBeNull();
    expect((await service.center()).unreadCount).toBe(0);

    await service.dismiss(center.items[0]!.id);
    expect((await service.center()).items).toHaveLength(0);
  });

  it("maps task cancellation to an actionable notification", async () => {
    const { task } = await createTask("cancel-notification");
    await service.reconcile();
    await tasks.cancel(task.id, "test cancellation");
    expect(await service.reconcile()).toBe(1);
    const center = await service.center();
    expect(center.items[0]?.title).toContain("取消");
    expect(center.items[0]?.severity).toBe("warning");
  });

  it("does not replay historical events when first started", async () => {
    const outbox = new OutboxRepository(ctx.app.db);
    await outbox.append("task.created", { task: { id: "legacy" } }, new Date().toISOString());
    const fresh = new NotificationsService(ctx.app.db, outbox, { pollIntervalMs: 60 * 60_000 });
    await fresh.onModuleInit();
    expect(await fresh.reconcile()).toBe(0);
    fresh.onModuleDestroy();
  });
});

describe("notificationForEvent", () => {
  it("requires action for approvals and reports resource pressure", () => {
    const approval = notificationForEvent(
      "task.approval_requested",
      {
        taskId: "task-1",
        actionType: "click",
        summary: "点击发送按钮",
      },
      {
        id: "task-1",
        projectId: "project-1",
        vmId: "vm-1",
        objective: "发送邮件",
        status: "waiting_approval",
        latestSummary: null,
        errorMessage: null,
      },
    );
    expect(approval?.kind).toBe("approval");
    expect(approval?.severity).toBe("warning");
    expect(approval?.projectId).toBe("project-1");

    const resource = notificationForEvent("resource.waiting_for_memory", {
      vmId: "vm-1",
      vmName: "工作 VM",
      taskIds: ["task-1", "task-2"],
      reason: "host reserve",
    });
    expect(resource?.kind).toBe("resource");
    expect(resource?.body).toContain("2 个任务");
  });

  it("ignores noisy progress and unknown topics", () => {
    expect(
      notificationForEvent(
        "task.status_changed",
        { taskId: "task-1", from: "queued", to: "running" },
        {
          id: "task-1",
          projectId: "project-1",
          vmId: "vm-1",
          objective: "运行",
          status: "running",
          latestSummary: null,
          errorMessage: null,
        },
      ),
    ).toBeNull();
    expect(notificationForEvent("unknown.topic", {})).toBeNull();
  });
});
