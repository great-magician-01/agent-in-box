import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { AppDatabase } from "./database";
import { OutboxRepository } from "./repositories/outbox-repository";
import { TaskRepository } from "./repositories/task-repository";
import { TaskService } from "./services/task-service";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.close();
});

describe("database operations", () => {
  it("backs up a consistent database that can be reopened", async () => {
    const service = new TaskService(
      ctx.app.db,
      new TaskRepository(ctx.app.db),
      new OutboxRepository(ctx.app.db),
    );
    await service.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective: "Backup test task",
      idempotencyKey: "backup-key",
    });

    const backupPath = path.join(ctx.dir, "backup.sqlite");
    await ctx.app.backup(backupPath);

    const backup = AppDatabase.open({ filename: backupPath });
    const task = await backup.db.selectFrom("tasks").selectAll().executeTakeFirst();
    expect(task?.objective).toBe("Backup test task");
    expect(await backup.migrate()).toEqual([]);
    await backup.close();
  });

  it("does not allow invalid foreign keys", async () => {
    await expect(
      ctx.app.db
        .insertInto("tasks")
        .values({
          id: "bad-task",
          project_id: "missing-project",
          vm_id: ctx.vmId,
          origin_conversation_id: ctx.conversationId,
          assigned_worker_id: null,
          parent_task_id: null,
          objective: "Invalid task",
          status: "created",
          priority: 0,
          latest_summary: null,
          error_code: null,
          created_at: "2026-11-10T00:00:00.000Z",
          started_at: null,
          completed_at: null,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
