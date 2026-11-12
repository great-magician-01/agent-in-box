import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { ProjectService } from "./project.service";

let ctx: TestContext;
let projects: ProjectService;
let catalog: CatalogRepository;

beforeEach(async () => {
  ctx = await createTestContext();
  catalog = new CatalogRepository(ctx.app.db);
  projects = new ProjectService(ctx.app.db, new OutboxRepository(ctx.app.db));
});

afterEach(async () => {
  await ctx.close();
});

async function createStoppedVm(name: string, osFamily: "linux" | "windows" = "linux") {
  const image = await ctx.app.db.selectFrom("images").select("id").executeTakeFirstOrThrow();
  return catalog.createVm({
    name,
    imageId: image.id,
    osFamily,
    cpuCount: 2,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    storageRoot: ctx.dir,
  });
}

describe("ProjectService", () => {
  it("creates, updates and validates project workspace configuration", async () => {
    const created = await projects.create({
      name: "  Desktop automation  ",
      description: "  Shared Linux work  ",
      workspaceConfig: { defaultGuestWorkspacePath: "/home/worker/demo/" },
    });
    expect(created.project.name).toBe("Desktop automation");
    expect(created.project.workspaceConfig.defaultGuestWorkspacePath).toBe("/home/worker/demo");
    expect(created.project.agentConfig).toEqual({ mcpEnabled: false });
    const updated = await projects.update(created.project.id, {
      description: "Updated",
      workspaceConfig: { defaultGuestWorkspacePath: "/home/worker/new" },
      agentConfig: { mcpEnabled: true },
    });
    expect(updated.project.description).toBe("Updated");
    expect(updated.project.workspaceConfig.defaultGuestWorkspacePath).toBe("/home/worker/new");
    expect(updated.project.agentConfig).toEqual({ mcpEnabled: true });
    await expect(
      projects.update(created.project.id, {
        workspaceConfig: { defaultGuestWorkspacePath: "/home/worker/../escape" },
      }),
    ).rejects.toThrow("without '..'");
    for (const workspaceConfig of [null, "invalid", {}]) {
      await expect(
        projects.update(created.project.id, { workspaceConfig: workspaceConfig as never }),
      ).rejects.toThrow("workspaceConfig");
    }
    for (const agentConfig of [null, "invalid", {}, { mcpEnabled: "yes" }]) {
      await expect(
        projects.update(created.project.id, { agentConfig: agentConfig as never }),
      ).rejects.toThrow("agentConfig");
    }
    const other = await projects.create({ name: "MCP remains disabled" });
    expect(other.project.agentConfig.mcpEnabled).toBe(false);
    expect((await projects.get(created.project.id)).project.workspaceConfig).toEqual(
      updated.project.workspaceConfig,
    );
    expect((await projects.get(created.project.id)).project.agentConfig.mcpEnabled).toBe(true);
  });

  it("supports many-to-many stopped VM bindings and atomic primary changes", async () => {
    const projectA = await projects.create({ name: "Project A" });
    const projectB = await projects.create({ name: "Project B" });
    const vmB = await createStoppedVm("Stopped VM B");
    await projects.bind(projectA.project.id, {
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/a",
    });
    const withSecond = await projects.bind(projectA.project.id, {
      vmId: vmB.id,
      guestWorkspacePath: "/home/worker/a-second",
    });
    expect(withSecond.bindings).toHaveLength(2);
    expect(withSecond.bindings.filter((item) => item.binding.isPrimary)).toHaveLength(1);
    expect(withSecond.bindings.every((item) => item.vm.powerState === "stopped")).toBe(true);
    await projects.bind(projectB.project.id, {
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/b",
    });

    const shared = await projects.get(projectA.project.id);
    const sharedBinding = shared.bindings.find((item) => item.vm.id === ctx.vmId);
    expect(sharedBinding?.sharedProjects.map((project) => project.name)).toEqual([
      "Test project",
      "Project A",
      "Project B",
    ]);
    const secondBinding = shared.bindings.find((item) => item.vm.id === vmB.id)!;
    const promoted = await projects.updateBinding(projectA.project.id, secondBinding.binding.id, {
      isPrimary: true,
      guestWorkspacePath: "/home/worker/promoted",
    });
    expect(promoted.project.defaultVmBindingId).toBe(secondBinding.binding.id);
    expect(promoted.bindings.filter((item) => item.binding.isPrimary)).toHaveLength(1);

    const afterUnbind = await projects.unbind(projectA.project.id, secondBinding.binding.id);
    expect(afterUnbind.bindings).toHaveLength(1);
    expect(afterUnbind.bindings[0]?.binding.isPrimary).toBe(true);
    expect(afterUnbind.project.defaultVmBindingId).toBe(afterUnbind.bindings[0]?.binding.id);
    expect(await catalog.getVm(vmB.id)).toBeDefined();
  });

  it("rejects workspace paths that do not match the target VM OS", async () => {
    const project = await projects.create({ name: "Mixed OS path validation" });
    const windowsVm = await createStoppedVm("Stopped Windows VM", "windows");
    await expect(
      projects.bind(project.project.id, {
        vmId: ctx.vmId,
        guestWorkspacePath: "C:\\Users\\aib\\AgentInBox\\workspace",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      projects.bind(project.project.id, {
        vmId: windowsVm.id,
        guestWorkspacePath: "/home/worker/workspace",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const bound = await projects.bind(project.project.id, {
      vmId: windowsVm.id,
      guestWorkspacePath: "C:\\Users\\aib\\AgentInBox\\workspace",
    });
    const windowsBinding = bound.bindings.find((item) => item.vm.id === windowsVm.id)!;
    await expect(
      projects.updateBinding(project.project.id, windowsBinding.binding.id, {
        guestWorkspacePath: "/home/worker/workspace",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(
      (await projects.get(project.project.id)).bindings.find(
        (item) => item.binding.id === windowsBinding.binding.id,
      )?.binding.guestWorkspacePath,
    ).toBe("C:\\Users\\aib\\AgentInBox\\workspace");

    await projects.bind(project.project.id, {
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/linux-workspace",
    });
  });

  it("deletes project metadata without deleting a shared VM", async () => {
    const project = await projects.create({ name: "Disposable project" });
    await projects.bind(project.project.id, {
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/disposable",
    });
    expect(await projects.delete(project.project.id)).toEqual({
      deleted: true,
      projectId: project.project.id,
    });
    expect(await catalog.getVm(ctx.vmId)).toBeDefined();
    expect((await projects.get(ctx.projectId)).bindings[0]?.vm.id).toBe(ctx.vmId);
    await expect(projects.get(project.project.id)).rejects.toThrow("项目不存在");
  });

  it("blocks project deletion when Worker history still depends on it", async () => {
    const project = await projects.create({ name: "Worker history project" });
    await projects.bind(project.project.id, {
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/history",
    });
    const now = new Date().toISOString();
    await ctx.app.db
      .insertInto("workers")
      .values({
        id: "history-worker",
        project_id: project.project.id,
        vm_id: ctx.vmId,
        conversation_id: ctx.conversationId,
        engine_type: "pi-rpc",
        engine_version: "1.5.1",
        status: "archived",
        current_task_id: null,
        capability_set: "[]",
        created_at: now,
        last_active_at: now,
        archived_at: now,
        agent_session_ref: null,
        session_version: null,
        last_heartbeat_at: null,
        archive_summary: null,
        last_error_code: null,
        last_error_message: null,
        broker_token_id: null,
        provider_id: null,
        model_id: null,
      })
      .execute();
    await expect(projects.delete(project.project.id)).rejects.toMatchObject({
      code: "conflict",
      details: { dependencies: { workers: true } },
    });
    expect(await catalog.getVm(ctx.vmId)).toBeDefined();
  });

  it("archives only inactive projects and prevents changes while archived", async () => {
    const tasks = new TaskService(
      ctx.app.db,
      new TaskRepository(ctx.app.db),
      new OutboxRepository(ctx.app.db),
    );
    const { task } = await tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective: "active task",
      idempotencyKey: "project-archive-active",
    });
    await expect(projects.setArchived(ctx.projectId, true)).rejects.toThrow("未结束任务");
    const binding = (await projects.get(ctx.projectId)).bindings[0]!;
    await expect(projects.unbind(ctx.projectId, binding.binding.id)).rejects.toThrow("未结束任务");
    await tasks.cancel(task.id);
    const archived = await projects.setArchived(ctx.projectId, true);
    expect(archived.project.archivedAt).not.toBeNull();
    await expect(projects.createConversation(ctx.projectId, "blocked")).rejects.toThrow("已归档");
    const restored = await projects.setArchived(ctx.projectId, false);
    expect(restored.project.archivedAt).toBeNull();
  });

  it("persists project conversations and activity references", async () => {
    const conversation = await projects.createConversation(ctx.projectId, "Research session");
    const detail = await projects.get(ctx.projectId);
    expect(detail.conversations.some((item) => item.id === conversation.id)).toBe(true);
    expect(detail.activities.map((activity) => activity.type)).toContain(
      "project.conversation_created",
    );
    const outbox = await ctx.app.db.selectFrom("outbox").selectAll().execute();
    expect(outbox.some((row) => row.topic === "project.changed")).toBe(true);
  });
});
