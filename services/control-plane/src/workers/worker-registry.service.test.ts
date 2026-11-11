import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@agent-in-box/protocol";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { WorkerRegistryService } from "./worker-registry.service";

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.close();
});

interface Harness {
  ctx: TestContext;
  registry: WorkerRegistryService;
  workers: WorkerRepository;
  archives: WorkerArchiveRepository;
  tasks: TaskService;
  taskRepository: TaskRepository;
  projectId: string;
  vmId: string;
  conversationId: string;
}

async function createHarness(): Promise<Harness> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy" })
    .where("id", "=", ctx.vmId)
    .execute();
  const workers = new WorkerRepository(ctx.app.db);
  const archives = new WorkerArchiveRepository(ctx.app.db);
  const outbox = new OutboxRepository(ctx.app.db);
  const taskRepository = new TaskRepository(ctx.app.db);
  const tasks = new TaskService(ctx.app.db, taskRepository, outbox);
  const registry = new WorkerRegistryService(ctx.app.db, workers, archives, tasks, outbox);
  return {
    ctx,
    registry,
    workers,
    archives,
    tasks,
    taskRepository,
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    conversationId: ctx.conversationId,
  };
}

async function createWorker(
  harness: Harness,
  status: "idle" | "running" | "failed" | "archived" = "idle",
): Promise<string> {
  const worker = await harness.workers.createWorker({
    projectId: harness.projectId,
    vmId: harness.vmId,
    conversationId: harness.conversationId,
    engineType: "pi-rpc",
    engineVersion: "1.5.1",
    capabilitySet: ["computer_use"],
  });
  await harness.workers.updateRuntime(worker.id, {
    status,
    ...(status === "archived" ? { archiveSummary: "archived worker summary" } : {}),
  });
  return worker.id;
}

async function insertTask(
  harness: Harness,
  input: Partial<TaskRecord> & { objective: string; status: TaskRecord["status"] },
): Promise<string> {
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: randomUUID(),
    projectId: harness.projectId,
    vmId: harness.vmId,
    originConversationId: harness.conversationId,
    assignedWorkerId: null,
    parentTaskId: null,
    objective: input.objective,
    status: input.status,
    priority: 0,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: input.status === "running" ? now : null,
    completedAt: null,
    latestSummary: input.latestSummary ?? null,
    result: null,
    errorCode: null,
    errorMessage: null,
    ...input,
  };
  await harness.taskRepository.insertTask(task);
  return task.id;
}

describe("WorkerRegistryService", () => {
  it("rebuilds the active roster from the database and hides archived Workers", async () => {
    const harness = await createHarness();
    const idleWorker = await createWorker(harness, "idle");
    const runningWorker = await createWorker(harness, "running");
    const archivedWorker = await createWorker(harness, "archived");
    await insertTask(harness, {
      objective: "older task",
      status: "completed",
      assignedWorkerId: idleWorker,
    });
    await insertTask(harness, {
      objective: "queued invoice task",
      status: "queued",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const runningTask = await insertTask(harness, {
      objective: "invoice export",
      status: "running",
      assignedWorkerId: runningWorker,
    });
    const actionId = randomUUID();
    await harness.ctx.app.db
      .insertInto("cua_actions")
      .values({
        id: actionId,
        task_id: runningTask,
        worker_id: runningWorker,
        vm_id: harness.vmId,
        lease_id: "lease-1",
        action_type: "type_text",
        action_json: "{}",
        source_screenshot_id: null,
        before_screenshot_id: null,
        after_screenshot_id: null,
        display_json: "{}",
        status: "pending_approval",
        result_json: null,
        error_code: null,
        error_message: null,
        approval_id: null,
        created_at: new Date().toISOString(),
        executed_at: null,
        duration_ms: null,
      })
      .execute();
    await harness.ctx.app.db
      .insertInto("cua_approvals")
      .values({
        id: randomUUID(),
        task_id: runningTask,
        worker_id: runningWorker,
        action_id: actionId,
        action_type: "type_text",
        action_json: "{}",
        context_summary: "approval",
        status: "pending",
        requested_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      })
      .execute();
    await harness.ctx.app.db
      .insertInto("worker_inputs")
      .values({
        id: randomUUID(),
        worker_id: idleWorker,
        kind: "follow_up",
        content: "next step",
        status: "pending",
        created_at: new Date().toISOString(),
        delivered_at: null,
      })
      .execute();

    const roster = await harness.registry.activeRoster(harness.projectId);
    expect(roster.workers.map((worker) => worker.workerId).sort()).toEqual(
      [idleWorker, runningWorker].sort(),
    );
    const running = roster.workers.find((worker) => worker.workerId === runningWorker)!;
    expect(running).toMatchObject({
      projectName: "Test project",
      vmName: "Test Linux VM",
      vmPowerState: "running",
      queueDepth: 1,
      pendingApprovals: 1,
      currentTask: { id: runningTask, objective: "invoice export" },
      status: "running",
    });
    const idle = roster.workers.find((worker) => worker.workerId === idleWorker)!;
    expect(idle.pendingInputs).toBe(1);
    expect(idle.recentTask?.objective).toBe("older task");

    const rebuilt = new WorkerRegistryService(
      harness.ctx.app.db,
      harness.workers,
      harness.archives,
      harness.tasks,
      new OutboxRepository(harness.ctx.app.db),
    );
    await expect(rebuilt.activeRoster(harness.projectId)).resolves.toMatchObject({
      workers: roster.workers,
    });

    const archived = await harness.registry.summary(archivedWorker);
    expect(archived.card).toBeNull();
    expect(archived.worker.status).toBe("archived");
  });

  it("blocks archiving for running, pending approval, pending input and lease holders", async () => {
    const harness = await createHarness();
    const worker = await createWorker(harness, "idle");
    await expect(harness.registry.archiveBlockers(worker)).resolves.toEqual({
      blocked: false,
      reasons: [],
    });

    const taskId = await insertTask(harness, {
      objective: "running task",
      status: "running",
      assignedWorkerId: worker,
    });
    await harness.ctx.app.db
      .insertInto("worker_inputs")
      .values({
        id: randomUUID(),
        worker_id: worker,
        kind: "steer",
        content: "queued",
        status: "pending",
        created_at: new Date().toISOString(),
        delivered_at: null,
      })
      .execute();
    await harness.ctx.app.db
      .insertInto("vm_leases")
      .values({
        id: randomUUID(),
        vm_id: harness.vmId,
        owner: "worker",
        task_id: taskId,
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .execute();

    const blockers = await harness.registry.archiveBlockers(worker);
    expect(blockers.blocked).toBe(true);
    expect(blockers.reasons.join("\n")).toContain("active_tasks");
    expect(blockers.reasons.join("\n")).toContain("pending_inputs");
    expect(blockers.reasons.join("\n")).toContain("execution_lease");
  });

  it("searches archives by project and summary text", async () => {
    const harness = await createHarness();
    const worker = await createWorker(harness, "archived");
    const archive = await harness.archives.create({
      workerId: worker,
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.conversationId,
      archiveRef: "/guest/backups/invoice.jsonl",
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      sessionVersion: "1",
      summary: "Finished the quarterly invoice reconciliation in LibreOffice.",
      restorePoint: null,
      artifacts: [
        {
          taskId: "task-1",
          name: "report.xlsx",
          relativePath: "reports/report.xlsx",
          sha256: "a".repeat(64),
          sizeBytes: 12,
        },
      ],
      source: "manual",
    });

    const byQuery = await harness.registry.searchArchives({ query: "invoice" });
    expect(byQuery.items.map((item) => item.id)).toContain(archive.id);
    const byArtifact = await harness.registry.searchArchives({ query: "report.xlsx" });
    expect(byArtifact.items.map((item) => item.id)).toContain(archive.id);
    const otherProject = await harness.registry.searchArchives({
      projectId: "another-project",
      query: "invoice",
    });
    expect(otherProject.items).toEqual([]);
  });

  it("suggests existing Workers only within the same project and scores archive matches", async () => {
    const harness = await createHarness();
    const idleWorker = await createWorker(harness, "idle");
    await insertTask(harness, {
      objective: "reconcile the quarterly invoice report",
      status: "completed",
      assignedWorkerId: idleWorker,
    });
    const archivedWorker = await createWorker(harness, "archived");
    const archive = await harness.archives.create({
      workerId: archivedWorker,
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.conversationId,
      archiveRef: "/guest/backups/archive.jsonl",
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      sessionVersion: "1",
      summary: "Prepared quarterly invoice spreadsheets",
      restorePoint: null,
      artifacts: [],
      source: "auto",
    });

    const related = await harness.registry.findRelatedWorker({
      conversationId: harness.conversationId,
      objective: "reconcile quarterly invoice",
      projectId: harness.projectId,
    });
    expect(related.projectId).toBe(harness.projectId);
    expect(related.fallback).toBe("none");
    expect(related.suggestions.some((item) => item.workerId === idleWorker)).toBe(true);
    const archivedSuggestion = related.suggestions.find((item) => item.archiveId === archive.id);
    expect(archivedSuggestion).toMatchObject({
      workerId: archivedWorker,
      recommendation: "resume",
      status: "archived",
    });

    const otherConversation = await harness.ctx.app.db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        kind: "project",
        project_id: null,
        title: "Router",
        created_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(
      harness.registry.findRelatedWorker({
        conversationId: otherConversation.id,
        objective: "unrelated",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
