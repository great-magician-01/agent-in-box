import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord, WorkerPromptRequest } from "@agent-in-box/protocol";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { WorkerRegistryService } from "../workers/worker-registry.service";
import type { WorkerRuntimeService } from "../workers/worker-runtime.service";
import { RouterToolService } from "./router-tool.service";

const contexts: TestContext[] = [];
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.close();
});

interface Harness {
  ctx: TestContext;
  tools: RouterToolService;
  tasks: TaskService;
  taskRepository: TaskRepository;
  workers: WorkerRepository;
  archives: WorkerArchiveRepository;
  routerConversationId: string;
  projectId: string;
  vmId: string;
  steerCalls: Array<{ workerId: string; input: WorkerPromptRequest }>;
  followUpCalls: Array<{ workerId: string; input: WorkerPromptRequest }>;
}

async function createHarness(): Promise<Harness> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy" })
    .where("id", "=", ctx.vmId)
    .execute();
  const outbox = new OutboxRepository(ctx.app.db);
  const taskRepository = new TaskRepository(ctx.app.db);
  const tasks = new TaskService(ctx.app.db, taskRepository, outbox);
  const workers = new WorkerRepository(ctx.app.db);
  const archives = new WorkerArchiveRepository(ctx.app.db);
  const registry = new WorkerRegistryService(ctx.app.db, workers, archives, tasks, outbox);
  const steerCalls: Harness["steerCalls"] = [];
  const followUpCalls: Harness["followUpCalls"] = [];
  const workerRuntime = {
    steer: async (workerId: string, input: WorkerPromptRequest) => {
      steerCalls.push({ workerId, input });
      return { disposition: "queued" as const, taskId: null };
    },
    followUp: async (workerId: string, input: WorkerPromptRequest) => {
      followUpCalls.push({ workerId, input });
      return { disposition: "queued" as const, taskId: null };
    },
  } as unknown as WorkerRuntimeService;
  const tools = new RouterToolService(ctx.app.db, tasks, registry, workerRuntime);
  const now = new Date().toISOString();
  const routerConversationId = randomUUID();
  await ctx.app.db
    .insertInto("conversations")
    .values({
      id: routerConversationId,
      kind: "router",
      project_id: null,
      title: "Router",
      created_at: now,
      last_message_at: now,
    })
    .execute();
  return {
    ctx,
    tools,
    tasks,
    taskRepository,
    workers,
    archives,
    routerConversationId,
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    steerCalls,
    followUpCalls,
  };
}

describe("RouterToolService", () => {
  it("exposes only project/task/Worker/board/archive tools", async () => {
    const harness = await createHarness();
    const names = harness.tools.definitions().map((definition) => definition.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_projects",
        "list_active_workers",
        "list_tasks",
        "get_task",
        "get_board_summary",
        "get_worker_summary",
        "find_related_worker",
        "search_worker_archive",
        "create_task",
        "assign_task",
        "steer_task",
        "follow_up_task",
        "reprioritize_task",
        "cancel_task",
        "retry_task",
        "resume_worker",
        "archive_worker",
      ]),
    );
    for (const forbidden of ["shell", "vm_input", "supervisor", "click", "keypress", "execute"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
    await expect(
      harness.tools.execute("vm_click", {}, { conversationId: harness.routerConversationId }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists projects and creates tasks on the primary VM with router provenance", async () => {
    const harness = await createHarness();
    const projects = await harness.tools.execute(
      "list_projects",
      {},
      { conversationId: harness.routerConversationId },
    );
    expect(projects).toEqual([
      expect.objectContaining({
        projectId: harness.projectId,
        bindings: [expect.objectContaining({ vmId: harness.vmId, isPrimary: true })],
      }),
    ]);

    const toolCall = {
      conversationId: harness.routerConversationId,
      toolCallId: "tool-call-weekly-report",
    };
    const first = (await harness.tools.execute(
      "create_task",
      { projectId: harness.projectId, objective: "Prepare the weekly report" },
      toolCall,
    )) as { created: boolean; task: { id: string; vmId: string; status: string } };
    expect(first.created).toBe(true);
    expect(first.task.vmId).toBe(harness.vmId);
    expect(first.task.status).toBe("queued");
    const task = await harness.tasks.get(first.task.id);
    expect(task?.originConversationId).toBe(harness.routerConversationId);

    const repeat = (await harness.tools.execute(
      "create_task",
      { projectId: harness.projectId, objective: "Prepare the weekly report" },
      toolCall,
    )) as { created: boolean; task: { id: string } };
    expect(repeat.created).toBe(false);
    expect(repeat.task.id).toBe(first.task.id);

    const board = (await harness.tools.execute(
      "get_board_summary",
      {},
      { conversationId: harness.routerConversationId },
    )) as { countsByStatus: Record<string, number> };
    expect(board.countsByStatus.queued).toBe(1);
  });

  it("creates a new task when the same objective is requested in a later tool call", async () => {
    const harness = await createHarness();
    const objective = "Prepare the weekly report";
    const first = (await harness.tools.execute(
      "create_task",
      { projectId: harness.projectId, objective },
      { conversationId: harness.routerConversationId, toolCallId: "tool-call-1" },
    )) as { created: boolean; task: { id: string } };
    const second = (await harness.tools.execute(
      "create_task",
      { projectId: harness.projectId, objective },
      { conversationId: harness.routerConversationId, toolCallId: "tool-call-2" },
    )) as { created: boolean; task: { id: string } };
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);
  });

  it("routes cross-project tasks to each project's primary VM", async () => {
    const harness = await createHarness();
    const catalog = new CatalogRepository(harness.ctx.app.db);
    const image = await harness.ctx.app.db
      .selectFrom("images")
      .select("id")
      .executeTakeFirstOrThrow();
    const otherProject = await catalog.createProject({
      name: "Other project",
      description: "Second project",
    });
    const otherVm = await catalog.createVm({
      name: "Other VM",
      imageId: image.id,
      osFamily: "linux",
      cpuCount: 2,
      memoryBytes: 2 * 1024 ** 3,
      diskBytes: 10 * 1024 ** 3,
      storageRoot: path.join(harness.ctx.dir, "other-vm"),
    });
    await catalog.bindVm({
      projectId: otherProject.id,
      vmId: otherVm.id,
      guestWorkspacePath: "/home/worker/workspace",
      isPrimary: true,
    });
    const first = (await harness.tools.execute(
      "create_task",
      { projectId: harness.projectId, objective: "First project task" },
      { conversationId: harness.routerConversationId },
    )) as { task: { vmId: string } };
    const second = (await harness.tools.execute(
      "create_task",
      { projectId: otherProject.id, objective: "Second project task" },
      { conversationId: harness.routerConversationId },
    )) as { task: { vmId: string } };
    expect(first.task.vmId).toBe(harness.vmId);
    expect(second.task.vmId).toBe(otherVm.id);
  });

  it("assigns work to an existing Worker's project and VM", async () => {
    const harness = await createHarness();
    const worker = await harness.workers.createWorker({
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.ctx.conversationId,
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      capabilitySet: ["computer_use"],
    });
    await harness.workers.updateRuntime(worker.id, { status: "idle" });
    const result = (await harness.tools.execute(
      "assign_task",
      { workerId: worker.id, objective: "Check the invoice totals" },
      { conversationId: harness.routerConversationId },
    )) as { task: { id: string; vmId: string } };
    expect(result.task.vmId).toBe(harness.vmId);
    const task = await harness.tasks.get(result.task.id);
    expect(task?.projectId).toBe(harness.projectId);
  });

  it("steers and follows up only assigned tasks", async () => {
    const harness = await createHarness();
    const worker = await harness.workers.createWorker({
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.ctx.conversationId,
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      capabilitySet: ["computer_use"],
    });
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      projectId: harness.projectId,
      vmId: harness.vmId,
      originConversationId: harness.routerConversationId,
      assignedWorkerId: worker.id,
      parentTaskId: null,
      objective: "running task",
      status: "running",
      priority: 0,
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      latestSummary: null,
      result: null,
      errorCode: null,
      errorMessage: null,
    };
    await harness.taskRepository.insertTask(task);
    await harness.tools.execute(
      "steer_task",
      { taskId, text: "use the export button" },
      { conversationId: harness.routerConversationId },
    );
    expect(harness.steerCalls).toEqual([
      { workerId: worker.id, input: { text: "use the export button" } },
    ]);
    await harness.tools.execute(
      "follow_up_task",
      { taskId, text: "then close the app" },
      { conversationId: harness.routerConversationId },
    );
    expect(harness.followUpCalls).toEqual([
      { workerId: worker.id, input: { text: "then close the app" } },
    ]);
  });

  it("finds related Workers and searches archived summaries", async () => {
    const harness = await createHarness();
    const worker = await harness.workers.createWorker({
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.ctx.conversationId,
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      capabilitySet: ["computer_use"],
    });
    await harness.workers.updateRuntime(worker.id, { status: "idle" });
    await harness.archives.create({
      workerId: worker.id,
      projectId: harness.projectId,
      vmId: harness.vmId,
      conversationId: harness.ctx.conversationId,
      archiveRef: "/guest/backups/invoice.jsonl",
      engineType: "pi-rpc",
      engineVersion: "1.5.1",
      sessionVersion: "1",
      summary: "Prepared the invoice workbook",
      restorePoint: null,
      artifacts: [],
      source: "manual",
    });
    const related = (await harness.tools.execute(
      "find_related_worker",
      { objective: "invoice workbook follow-up", projectId: harness.projectId },
      { conversationId: harness.routerConversationId },
    )) as { suggestions: Array<{ workerId: string }> };
    expect(related.suggestions.some((item) => item.workerId === worker.id)).toBe(true);
    const archives = (await harness.tools.execute(
      "search_worker_archive",
      { projectId: harness.projectId, query: "invoice" },
      { conversationId: harness.routerConversationId },
    )) as { items: Array<{ summary: string }> };
    expect(archives.items[0]?.summary).toContain("invoice");
  });
});
