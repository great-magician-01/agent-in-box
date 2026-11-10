import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePageRequest } from "@agent-in-box/protocol";
import { IdempotencyConflictError, InvalidTransitionError } from "./errors";
import { OutboxRepository } from "./repositories/outbox-repository";
import { TaskRepository } from "./repositories/task-repository";
import { TaskService } from "./services/task-service";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;
let service: TaskService;
let taskRepository: TaskRepository;

beforeEach(async () => {
  ctx = await createTestContext();
  taskRepository = new TaskRepository(ctx.app.db);
  service = new TaskService(ctx.app.db, taskRepository, new OutboxRepository(ctx.app.db));
});

afterEach(async () => {
  await ctx.close();
});

function taskInput(objective = "Open the browser and verify the page") {
  return {
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    originConversationId: ctx.conversationId,
    objective,
    idempotencyKey: "create-task-key-1",
  };
}

describe("TaskService", () => {
  it("creates a task idempotently", async () => {
    const first = await service.create(taskInput());
    const second = await service.create(taskInput());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(first.task.status).toBe("created");

    const rows = await ctx.app.db.selectFrom("tasks").selectAll().execute();
    expect(rows).toHaveLength(1);

    const events = await taskRepository.listEvents(first.task.id);
    expect(events.map((event) => event.type)).toEqual(["task.created"]);
  });

  it("rejects the same idempotency key with a different request", async () => {
    await service.create(taskInput("First objective"));

    await expect(service.create(taskInput("Different objective"))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("applies legal transitions and records events in the outbox", async () => {
    const { task } = await service.create(taskInput());

    await service.transition(task.id, "queued");
    const running = await service.transition(task.id, "running");
    const completed = await service.transition(task.id, "completed", {
      summary: "Page verified",
    });

    expect(running.startedAt).not.toBeNull();
    expect(completed.completedAt).not.toBeNull();
    expect(completed.latestSummary).toBe("Page verified");

    const events = await taskRepository.listEvents(task.id);
    expect(events.map((event) => event.type)).toEqual([
      "task.created",
      "task.status_changed",
      "task.status_changed",
      "task.status_changed",
    ]);

    const outboxRows = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(outboxRows).toHaveLength(4);
    expect(outboxRows.map((row) => row.topic)).toContain("task.created");
  });

  it("rejects illegal transitions without changing the task", async () => {
    const { task } = await service.create(taskInput());

    await expect(service.transition(task.id, "completed")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    const stored = await service.get(task.id);
    expect(stored?.status).toBe("created");
    expect(await taskRepository.listEvents(task.id)).toHaveLength(1);
  });

  it("paginates tasks with a stable cursor", async () => {
    await service.create({ ...taskInput("Task A"), idempotencyKey: "page-key-a" });
    await service.create({ ...taskInput("Task B"), idempotencyKey: "page-key-b" });
    await service.create({ ...taskInput("Task C"), idempotencyKey: "page-key-c" });

    const firstPage = await service.list(normalizePageRequest({ limit: 2 }));
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.list(
      normalizePageRequest({
        limit: 2,
        ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
      }),
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const ids = new Set([...firstPage.items, ...secondPage.items].map((task) => task.id));
    expect(ids.size).toBe(3);
  });
});
