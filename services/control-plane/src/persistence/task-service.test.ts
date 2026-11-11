import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePageRequest } from "@agent-in-box/protocol";
import { IdempotencyConflictError, InvalidTransitionError } from "./errors";
import { AppDatabase } from "./database";
import { OutboxRepository } from "./repositories/outbox-repository";
import { TaskRepository } from "./repositories/task-repository";
import { CatalogRepository } from "./repositories/catalog-repository";
import { WorkerRepository } from "./repositories/worker-repository";
import { TaskService, type CreateTaskInput } from "./services/task-service";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;
let service: TaskService;
let taskRepository: TaskRepository;

beforeEach(async () => {
  ctx = await createTestContext();
  taskRepository = new TaskRepository(ctx.app.db);
  mkdirSync(path.join(ctx.dir, "artifacts"), { recursive: true });
  service = createService(ctx.app, ctx.dir);
});

afterEach(async () => {
  await ctx.close();
});

function createService(app: AppDatabase, dir: string): TaskService {
  return new TaskService(app.db, new TaskRepository(app.db), new OutboxRepository(app.db), {
    artifactRoot: path.join(dir, "artifacts"),
  });
}

function taskInput(objective = "Open the browser and verify the page"): CreateTaskInput {
  return {
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    originConversationId: ctx.conversationId,
    objective,
    idempotencyKey: "create-task-key-1",
  };
}

async function setVmRunning(): Promise<void> {
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running" })
    .where("id", "=", ctx.vmId)
    .execute();
}

describe("TaskService", () => {
  it("creates a task idempotently with one durable timeline", async () => {
    const first = await service.create(taskInput());
    const second = await service.create(taskInput());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(first.task.status).toBe("waiting_vm");
    expect(await ctx.app.db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
    const events = await taskRepository.listEvents(first.task.id);
    expect(events.map((event) => event.type)).toEqual(["task.created"]);
  });

  it("rejects the same idempotency key with a different request", async () => {
    await service.create(taskInput("First objective"));
    await expect(service.create(taskInput("Different objective"))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("applies legal transitions and records events and outbox atomically", async () => {
    const { task } = await service.create(taskInput());
    await service.transition(task.id, "queued");
    const running = await service.transition(task.id, "running");
    const completed = await service.complete(task.id, { summary: "Page verified" });

    expect(running.startedAt).not.toBeNull();
    expect(running.attemptCount).toBe(0); // direct internal transitions do not impersonate a queue claim
    expect(completed.completedAt).not.toBeNull();
    expect(completed.latestSummary).toBe("Page verified");
    expect((await taskRepository.listEvents(task.id)).map((event) => event.type)).toEqual([
      "task.created",
      "task.status_changed",
      "task.status_changed",
      "task.status_changed",
    ]);
    const outboxRows = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(outboxRows).toHaveLength(4);
    expect(outboxRows.map((row) => row.topic)).toContain("task.created");
  });

  it("rejects illegal or unverified completion without changing the task", async () => {
    const { task } = await service.create(taskInput());
    await expect(service.transition(task.id, "completed")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await expect(service.complete(task.id, { summary: "not running" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect((await service.get(task.id))?.status).toBe("waiting_vm");
    expect(await taskRepository.listEvents(task.id)).toHaveLength(1);
  });

  it("paginates tasks with a stable cursor and filters the board", async () => {
    await service.create({ ...taskInput("Task A"), idempotencyKey: "page-key-a" });
    await service.create({ ...taskInput("Task B"), idempotencyKey: "page-key-b", priority: 8 });
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
    expect(new Set([...firstPage.items, ...secondPage.items].map((task) => task.id)).size).toBe(3);
    const board = await service.board({ projectId: ctx.projectId, statuses: ["waiting_vm"] });
    expect(board.tasks).toHaveLength(3);
    expect(board.projects[0]?.workspaceConfig.defaultGuestWorkspacePath).toBe(
      "/home/worker/workspace",
    );
  });

  it("gates dependencies and wakes dependents only after verified completion", async () => {
    await setVmRunning();
    const dependency = (await service.create({ ...taskInput("dependency"), idempotencyKey: "dep" }))
      .task;
    const dependent = (
      await service.create({
        ...taskInput("dependent"),
        idempotencyKey: "dependent",
        dependsOn: [dependency.id],
      })
    ).task;
    expect(dependent.status).toBe("created");
    expect((await service.claimNext(ctx.vmId))?.id).toBe(dependency.id);
    expect(await service.claimNext(ctx.vmId)).toBeNull(); // the running dependency owns this VM
    await service.complete(dependency.id, { summary: "dependency verified" });
    expect((await service.get(dependent.id))?.status).toBe("queued");
    expect((await service.claimNext(ctx.vmId))?.id).toBe(dependent.id);
    const detail = await service.detail(dependent.id);
    expect(detail.dependencies.map((task) => task.id)).toEqual([dependency.id]);
    expect(detail.events.map((event) => event.type)).toContain("task.created");
  });

  it("verifies artifact hashes and revalidation before exposing completion evidence", async () => {
    await setVmRunning();
    const artifactPath = path.join(ctx.dir, "artifacts", "report", "result.txt");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, "verified result\n");
    const sha256 = createHash("sha256").update("verified result\n").digest("hex");
    const { task } = await service.create(taskInput());
    await service.claimNext(ctx.vmId);
    await service.complete(task.id, {
      summary: "report created",
      result: { checked: true },
      artifacts: [
        {
          relativePath: "report/result.txt",
          sha256,
          sizeBytes: Buffer.byteLength("verified result\n"),
          mediaType: "text/plain",
        },
      ],
    });
    const detail = await service.detail(task.id);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.result).toEqual({ checked: true });
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.artifacts[0]?.verifiedAt).not.toBeNull();
    expect(detail.events.map((event) => event.type)).toContain("task.artifacts_verified");

    const eventCount = detail.events.length;
    await expect(service.verifyArtifact(detail.artifacts[0]!.id, "another-task")).rejects.toThrow(
      "不属于该任务",
    );
    expect((await service.detail(task.id)).events).toHaveLength(eventCount);
    expect((await service.detail(task.id)).artifacts[0]?.verifiedAt).not.toBeNull();

    writeFileSync(artifactPath, "tampered\n");
    await expect(service.verifyArtifact(detail.artifacts[0]!.id)).rejects.toThrow("SHA-256");
    const afterTamper = await service.detail(task.id);
    expect(afterTamper.artifacts[0]?.verifiedAt).toBeNull();
    expect(afterTamper.events.map((event) => event.type)).toContain(
      "task.artifact_verification_failed",
    );
  });

  it("rejects bad artifact paths and hashes without completing the task", async () => {
    await setVmRunning();
    const { task } = await service.create(taskInput());
    await service.claimNext(ctx.vmId);
    await expect(
      service.complete(task.id, {
        summary: "bad",
        artifacts: [{ relativePath: "../outside", sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow("相对 POSIX 路径");
    await expect(
      service.complete(task.id, {
        summary: "bad",
        artifacts: [{ relativePath: "missing.txt", sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow("不存在");
    expect((await service.get(task.id))?.status).toBe("running");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink artifact without opening its outside-root target",
    async () => {
      await setVmRunning();
      const outside = path.join(ctx.dir, "outside.txt");
      writeFileSync(outside, "outside secret\n");
      symlinkSync(outside, path.join(ctx.dir, "artifacts", "linked.txt"));
      const { task } = await service.create(taskInput());
      await service.claimNext(ctx.vmId);
      await expect(
        service.complete(task.id, {
          summary: "symlink",
          artifacts: [
            {
              relativePath: "linked.txt",
              sha256: createHash("sha256").update("outside secret\n").digest("hex"),
            },
          ],
        }),
      ).rejects.toThrow("无法安全打开");
      expect((await service.get(task.id))?.status).toBe("running");
      expect((await service.detail(task.id)).artifacts).toHaveLength(0);
    },
  );

  it("serializes one VM queue across projects and orders by priority", async () => {
    await setVmRunning();
    const catalog = new CatalogRepository(ctx.app.db);
    const secondProject = await catalog.createProject({ name: "Second project" });
    await catalog.bindVm({
      projectId: secondProject.id,
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/second",
      isPrimary: true,
    });
    const secondConversation = await catalog.createConversation({
      kind: "project",
      projectId: secondProject.id,
      title: "Second conversation",
    });
    const low = (await service.create({ ...taskInput("low"), idempotencyKey: "low", priority: 0 }))
      .task;
    const high = (
      await service.create({
        ...taskInput("high"),
        projectId: secondProject.id,
        originConversationId: secondConversation.id,
        idempotencyKey: "high",
        priority: 50,
      })
    ).task;
    const board = await service.board({ vmId: ctx.vmId });
    expect(board.tasks.find((task) => task.id === high.id)?.queuePosition).toBe(1);
    expect(board.tasks.find((task) => task.id === low.id)?.queuePosition).toBe(2);
    expect((await service.claimNext(ctx.vmId))?.id).toBe(high.id);
    expect(await service.claimNext(ctx.vmId)).toBeNull();
    await service.cancel(high.id, "test cancellation");
    expect((await service.claimNext(ctx.vmId))?.id).toBe(low.id);
  });

  it("supports failure records, retry, cancellation and safe priority changes", async () => {
    await setVmRunning();
    const { task } = await service.create(taskInput());
    await service.setPriority(task.id, 500);
    expect((await service.get(task.id))?.priority).toBe(100);
    await service.claimNext(ctx.vmId);
    const failed = await service.fail(task.id, "worker_crashed", "Worker exited");
    expect(failed.errorCode).toBe("worker_crashed");
    expect(failed.errorMessage).toBe("Worker exited");
    expect(failed.completedAt).toBeNull();
    const retried = await service.retry(task.id);
    expect(retried.status).toBe("queued");
    expect(retried.errorCode).toBeNull();
    expect(retried.startedAt).toBeNull();
    expect((await service.claimNext(ctx.vmId))?.attemptCount).toBe(2);
    const cancelled = await service.cancel(task.id, "stop this attempt");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).not.toBeNull();
    expect(await service.cancel(task.id)).toEqual(cancelled);
    await expect(service.retry(task.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("moves queued work back to waiting_vm and never claims on a stopped VM", async () => {
    await setVmRunning();
    const { task } = await service.create(taskInput());
    expect(task.status).toBe("queued");
    await ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "stopped" })
      .where("id", "=", ctx.vmId)
      .execute();
    expect(await service.claimNext(ctx.vmId)).toBeNull();
    expect((await service.get(task.id))?.status).toBe("waiting_vm");
    await setVmRunning();
    await service.reconcileVm(ctx.vmId);
    expect((await service.get(task.id))?.status).toBe("queued");
    expect((await service.claimNext(ctx.vmId))?.id).toBe(task.id);
  });

  it("revalidates project archive, binding and VM state when retrying", async () => {
    await setVmRunning();
    const { task } = await service.create(taskInput());
    await service.claimNext(ctx.vmId);
    await service.fail(task.id, "retry_guard", "failed before retry");
    await ctx.app.db
      .updateTable("projects")
      .set({ archived_at: new Date().toISOString() })
      .where("id", "=", ctx.projectId)
      .execute();
    await expect(service.retry(task.id)).rejects.toThrow("已归档项目");
    await ctx.app.db
      .updateTable("projects")
      .set({ archived_at: null })
      .where("id", "=", ctx.projectId)
      .execute();
    await ctx.app.db
      .deleteFrom("project_vm_bindings")
      .where("project_id", "=", ctx.projectId)
      .where("vm_id", "=", ctx.vmId)
      .execute();
    await expect(service.retry(task.id)).rejects.toThrow("已解绑");

    const catalog = new CatalogRepository(ctx.app.db);
    await catalog.bindVm({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/workspace",
      isPrimary: true,
    });
    await ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "stopped" })
      .where("id", "=", ctx.vmId)
      .execute();
    expect((await service.retry(task.id)).status).toBe("waiting_vm");
    expect(await service.claimNext(ctx.vmId)).toBeNull();
  });

  it("does not let a project worker steal another project's queue head", async () => {
    await setVmRunning();
    const catalog = new CatalogRepository(ctx.app.db);
    const workers = new WorkerRepository(ctx.app.db);
    const worker = await workers.createWorker({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      conversationId: ctx.conversationId,
      engineType: "pi",
      engineVersion: "1.5.1",
      capabilitySet: [],
    });
    const otherProject = await catalog.createProject({ name: "Other project" });
    await catalog.bindVm({
      projectId: otherProject.id,
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/other",
      isPrimary: true,
    });
    const otherConversation = await catalog.createConversation({
      kind: "project",
      projectId: otherProject.id,
      title: "Other conversation",
    });
    const own = (await service.create({ ...taskInput("own"), idempotencyKey: "own-worker" })).task;
    const other = (
      await service.create({
        ...taskInput("other"),
        projectId: otherProject.id,
        originConversationId: otherConversation.id,
        idempotencyKey: "other-worker",
        priority: 100,
      })
    ).task;

    expect(await service.claimNext(ctx.vmId, worker.id)).toBeNull();
    expect((await service.get(own.id))?.status).toBe("queued");
    expect((await service.claimNext(ctx.vmId))?.id).toBe(other.id);
    await service.cancel(other.id);
    expect((await service.claimNext(ctx.vmId, worker.id))?.id).toBe(own.id);
  });

  it("does not claim a persisted running task again after a process reopen", async () => {
    await setVmRunning();
    const { task } = await service.create(taskInput());
    expect((await service.claimNext(ctx.vmId))?.id).toBe(task.id);
    await ctx.app.close();
    const reopened = AppDatabase.open({ filename: path.join(ctx.dir, "test.sqlite") });
    await reopened.migrate();
    ctx.app = reopened;
    taskRepository = new TaskRepository(reopened.db);
    service = createService(reopened, ctx.dir);

    expect(await service.claimNext(ctx.vmId)).toBeNull();
    expect((await service.get(task.id))?.attemptCount).toBe(1);
    expect((await service.create(taskInput())).created).toBe(false);
    expect((await service.board()).tasks.filter((item) => item.status === "running")).toHaveLength(
      1,
    );
  });
});
