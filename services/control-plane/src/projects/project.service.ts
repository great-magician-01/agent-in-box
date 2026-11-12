import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  ACTIVE_TASK_STATUSES,
  type ConversationRecord,
  type ProjectBindingRequest,
  type ProjectBindingUpdateRequest,
  type ProjectBindingView,
  type ProjectCreateRequest,
  type ProjectDetail,
  type ProjectRecord,
  type ProjectUpdateRequest,
  type ProjectView,
} from "@agent-in-box/protocol";
import { isWindowsGuestPath, normalizeGuestWorkspacePath } from "@agent-in-box/domain";
import type { DatabaseService } from "../persistence/database.service";
import type { DatabaseExecutor } from "../persistence/executor";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import {
  toConversationRecord,
  toProjectActivityRecord,
  toProjectRecord,
  toProjectVmBindingRecord,
  toTaskArtifactRecord,
  toVmInstanceRecord,
} from "../persistence/mappers";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";

@Injectable()
export class ProjectService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly outbox: OutboxRepository,
    @Optional() private readonly database?: DatabaseService,
  ) {}

  async list(includeArchived = false): Promise<ProjectView[]> {
    let query = this.db.selectFrom("projects").selectAll().orderBy("created_at", "desc");
    if (!includeArchived) query = query.where("archived_at", "is", null);
    const rows = await query.execute();
    return Promise.all(rows.map((row) => this.view(toProjectRecord(row))));
  }

  async create(input: ProjectCreateRequest): Promise<ProjectDetail> {
    const name = normalizeName(input?.name);
    const description = normalizeDescription(input?.description);
    const workspaceConfig = normalizeWorkspace(input?.workspaceConfig);
    const now = nowIso();
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("projects")
        .values({
          id,
          name,
          description,
          default_vm_binding_id: null,
          workspace_config_json: JSON.stringify(workspaceConfig),
          created_at: now,
          updated_at: now,
          archived_at: null,
        })
        .execute();
      await this.record(id, "project.created", { name }, "created", now, trx);
    });
    return this.get(id);
  }

  async get(projectId: string): Promise<ProjectDetail> {
    const row = await this.db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`项目不存在：${projectId}`);
    const [view, conversations, activities, artifacts] = await Promise.all([
      this.view(toProjectRecord(row)),
      this.db
        .selectFrom("conversations")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("last_message_at", "desc")
        .execute(),
      this.db
        .selectFrom("project_activities")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("id", "desc")
        .limit(100)
        .execute(),
      this.db
        .selectFrom("task_artifacts")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at", "desc")
        .limit(100)
        .execute(),
    ]);
    return {
      ...view,
      conversations: conversations.map(toConversationRecord),
      activities: activities.map(toProjectActivityRecord),
      artifacts: artifacts.map(toTaskArtifactRecord),
    };
  }

  async update(projectId: string, input: ProjectUpdateRequest): Promise<ProjectDetail> {
    await this.requireActive(projectId);
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", projectId)
        .executeTakeFirstOrThrow();
      const name = input.name === undefined ? current.name : normalizeName(input.name);
      const description =
        input.description === undefined
          ? current.description
          : normalizeDescription(input.description);
      const workspace =
        input.workspaceConfig === undefined
          ? toProjectRecord(current).workspaceConfig
          : normalizeWorkspace(input.workspaceConfig);
      await trx
        .updateTable("projects")
        .set({
          name,
          description,
          workspace_config_json: JSON.stringify(workspace),
          updated_at: now,
        })
        .where("id", "=", projectId)
        .execute();
      await this.record(
        projectId,
        "project.updated",
        { name, description, workspaceConfig: workspace },
        "updated",
        now,
        trx,
      );
    });
    return this.get(projectId);
  }

  async setArchived(projectId: string, archived: boolean): Promise<ProjectDetail> {
    const current = await this.requireProject(projectId);
    if (archived) {
      const active = await this.db
        .selectFrom("tasks")
        .select("id")
        .where("project_id", "=", projectId)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .limit(1)
        .executeTakeFirst();
      if (active) {
        throw new PersistenceError("conflict", "项目仍有未结束任务，请先取消或等待完成");
      }
    }
    if ((current.archivedAt !== null) === archived) return this.get(projectId);
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("projects")
        .set({ archived_at: archived ? now : null, updated_at: now })
        .where("id", "=", projectId)
        .execute();
      await this.record(
        projectId,
        archived ? "project.archived" : "project.restored",
        {},
        archived ? "archived" : "restored",
        now,
        trx,
      );
    });
    return this.get(projectId);
  }

  async delete(projectId: string): Promise<{ deleted: true; projectId: string }> {
    await this.requireProject(projectId);
    const [task, worker, archive, backups] = await Promise.all([
      this.db
        .selectFrom("tasks")
        .select("id")
        .where("project_id", "=", projectId)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("workers")
        .select("id")
        .where("project_id", "=", projectId)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("worker_archives")
        .select("id")
        .where("project_id", "=", projectId)
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom("project_backups")
        .select(["id", "status"])
        .where("project_id", "=", projectId)
        .execute(),
    ]);
    if (backups.some((backup) => ["creating", "restoring"].includes(backup.status))) {
      throw new PersistenceError("conflict", "项目备份正在创建或恢复，暂不能删除项目");
    }
    const dependencies: Record<string, unknown> = {};
    if (task) dependencies.tasks = true;
    if (worker) dependencies.workers = true;
    if (archive) dependencies.workerArchives = true;
    if (Object.keys(dependencies).length > 0) {
      throw new PersistenceError(
        "conflict",
        "已有任务、Worker 或归档历史的项目只能归档，不能删除",
        { dependencies },
      );
    }
    // Project backups are project-owned. Remove their files only after the
    // dependency check passed; the database rows cascade with the project.
    if (backups.length > 0 && this.database && isSafeIdentifier(projectId)) {
      const root = path.resolve(this.database.layout.archives, "project-backups");
      const directory = path.resolve(root, projectId);
      const relative = path.relative(root, directory);
      if (relative === projectId && !path.isAbsolute(relative)) {
        await rm(directory, { recursive: true, force: true });
      }
    }
    await this.db.transaction().execute(async (trx) => {
      // Foreign keys cascade only project-owned metadata. VM rows and disks are
      // deliberately not touched, including when another project shares them.
      await trx.deleteFrom("projects").where("id", "=", projectId).execute();
      await this.outbox.append("project.changed", { projectId, action: "deleted" }, nowIso(), trx);
    });
    return { deleted: true, projectId };
  }

  async bind(projectId: string, input: ProjectBindingRequest): Promise<ProjectDetail> {
    await this.requireActive(projectId);
    if (typeof input?.vmId !== "string" || !input.vmId.trim()) {
      throw new PersistenceError("validation_failed", "必须选择要绑定的 VM");
    }
    const vmId = input.vmId.trim();
    const vm = await this.db
      .selectFrom("vm_instances")
      .select(["id", "os_family"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!vm) throw new NotFoundError(`VM 不存在：${vmId}`);
    const guestWorkspacePath = normalizeWorkspacePathForVm(input.guestWorkspacePath, vm.os_family);
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("project_vm_bindings")
        .select("id")
        .where("project_id", "=", projectId)
        .where("vm_id", "=", vmId)
        .executeTakeFirst();
      if (existing) throw new PersistenceError("conflict", "该 VM 已绑定到项目");
      const bindings = await trx
        .selectFrom("project_vm_bindings")
        .select("id")
        .where("project_id", "=", projectId)
        .execute();
      const isPrimary = input.isPrimary === true || bindings.length === 0;
      if (isPrimary) {
        await trx
          .updateTable("project_vm_bindings")
          .set({ is_primary: 0 })
          .where("project_id", "=", projectId)
          .execute();
      }
      const bindingId = randomUUID();
      await trx
        .insertInto("project_vm_bindings")
        .values({
          id: bindingId,
          project_id: projectId,
          vm_id: vmId,
          guest_workspace_path: guestWorkspacePath,
          is_primary: isPrimary ? 1 : 0,
          created_at: now,
        })
        .execute();
      if (isPrimary) {
        await trx
          .updateTable("projects")
          .set({ default_vm_binding_id: bindingId, updated_at: now })
          .where("id", "=", projectId)
          .execute();
      }
      await this.record(
        projectId,
        "project.vm_bound",
        { bindingId, vmId, isPrimary },
        "binding_changed",
        now,
        trx,
      );
    });
    return this.get(projectId);
  }

  async updateBinding(
    projectId: string,
    bindingId: string,
    input: ProjectBindingUpdateRequest,
  ): Promise<ProjectDetail> {
    await this.requireActive(projectId);
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      const binding = await trx
        .selectFrom("project_vm_bindings")
        .selectAll()
        .where("id", "=", bindingId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!binding) throw new NotFoundError(`项目 VM 绑定不存在：${bindingId}`);
      let guestWorkspacePath: string | undefined;
      if (input.guestWorkspacePath !== undefined) {
        const vm = await trx
          .selectFrom("vm_instances")
          .select("os_family")
          .where("id", "=", binding.vm_id)
          .executeTakeFirst();
        if (!vm) throw new NotFoundError(`VM 不存在：${binding.vm_id}`);
        guestWorkspacePath = normalizeWorkspacePathForVm(input.guestWorkspacePath, vm.os_family);
      }
      if (input.isPrimary === false && binding.is_primary === 1) {
        throw new PersistenceError("conflict", "请先将另一个绑定设为主 VM");
      }
      if (input.isPrimary === true) {
        await trx
          .updateTable("project_vm_bindings")
          .set({ is_primary: 0 })
          .where("project_id", "=", projectId)
          .execute();
      }
      await trx
        .updateTable("project_vm_bindings")
        .set({
          guest_workspace_path: guestWorkspacePath ?? binding.guest_workspace_path,
          ...(input.isPrimary === true ? { is_primary: 1 } : {}),
        })
        .where("id", "=", bindingId)
        .execute();
      if (input.isPrimary === true) {
        await trx
          .updateTable("projects")
          .set({ default_vm_binding_id: bindingId, updated_at: now })
          .where("id", "=", projectId)
          .execute();
      }
      await this.record(
        projectId,
        "project.vm_binding_updated",
        { bindingId },
        "binding_changed",
        now,
        trx,
      );
    });
    return this.get(projectId);
  }

  async unbind(projectId: string, bindingId: string): Promise<ProjectDetail> {
    await this.requireActive(projectId);
    const binding = await this.db
      .selectFrom("project_vm_bindings")
      .selectAll()
      .where("id", "=", bindingId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    if (!binding) throw new NotFoundError(`项目 VM 绑定不存在：${bindingId}`);
    const active = await this.db
      .selectFrom("tasks")
      .select("id")
      .where("project_id", "=", projectId)
      .where("vm_id", "=", binding.vm_id)
      .where("status", "in", ACTIVE_TASK_STATUSES)
      .limit(1)
      .executeTakeFirst();
    if (active) throw new PersistenceError("conflict", "该项目在此 VM 上仍有未结束任务，不能解绑");
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("project_vm_bindings").where("id", "=", bindingId).execute();
      let defaultBindingId: string | null = null;
      if (binding.is_primary === 1) {
        const next = await trx
          .selectFrom("project_vm_bindings")
          .select("id")
          .where("project_id", "=", projectId)
          .orderBy("created_at", "asc")
          .limit(1)
          .executeTakeFirst();
        if (next) {
          defaultBindingId = next.id;
          await trx
            .updateTable("project_vm_bindings")
            .set({ is_primary: 1 })
            .where("id", "=", next.id)
            .execute();
        }
      } else {
        defaultBindingId = (await this.requireProject(projectId, trx)).defaultVmBindingId;
      }
      await trx
        .updateTable("projects")
        .set({ default_vm_binding_id: defaultBindingId, updated_at: now })
        .where("id", "=", projectId)
        .execute();
      await this.record(
        projectId,
        "project.vm_unbound",
        { bindingId, vmId: binding.vm_id },
        "binding_changed",
        now,
        trx,
      );
    });
    return this.get(projectId);
  }

  async createConversation(projectId: string, titleInput: string): Promise<ConversationRecord> {
    await this.requireActive(projectId);
    const title = typeof titleInput === "string" ? titleInput.trim() : "";
    if (!title || title.length > 120) {
      throw new PersistenceError("validation_failed", "会话标题必须为 1～120 个字符");
    }
    const now = nowIso();
    const conversation: ConversationRecord = {
      id: randomUUID(),
      kind: "project",
      projectId,
      title,
      createdAt: now,
      lastMessageAt: now,
    };
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("conversations")
        .values({
          id: conversation.id,
          kind: "project",
          project_id: projectId,
          title,
          created_at: now,
          last_message_at: now,
        })
        .execute();
      await this.record(
        projectId,
        "project.conversation_created",
        { conversationId: conversation.id, title },
        "conversation_created",
        now,
        trx,
      );
    });
    return conversation;
  }

  private async view(project: ProjectRecord): Promise<ProjectView> {
    const [bindingRows, conversations, activeTasks] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("created_at", "asc")
        .execute(),
      this.db
        .selectFrom("conversations")
        .select("id")
        .where("project_id", "=", project.id)
        .execute(),
      this.db
        .selectFrom("tasks")
        .select("id")
        .where("project_id", "=", project.id)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .execute(),
    ]);
    const bindings: ProjectBindingView[] = await Promise.all(
      bindingRows.map(async (row) => {
        const [vm, shared, active, sharedActive, workers] = await Promise.all([
          this.db
            .selectFrom("vm_instances")
            .selectAll()
            .where("id", "=", row.vm_id)
            .executeTakeFirstOrThrow(),
          this.db
            .selectFrom("project_vm_bindings")
            .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
            .select([
              "projects.id as id",
              "projects.name as name",
              "projects.archived_at as archived_at",
              "project_vm_bindings.is_primary as is_primary",
            ])
            .where("project_vm_bindings.vm_id", "=", row.vm_id)
            .orderBy("projects.created_at", "asc")
            .execute(),
          this.db
            .selectFrom("tasks")
            .select("id")
            .where("vm_id", "=", row.vm_id)
            .where("project_id", "=", project.id)
            .where("status", "in", ACTIVE_TASK_STATUSES)
            .execute(),
          this.db
            .selectFrom("tasks")
            .select("id")
            .where("vm_id", "=", row.vm_id)
            .where("status", "in", ACTIVE_TASK_STATUSES)
            .execute(),
          this.db
            .selectFrom("workers")
            .select(["id", "status", "current_task_id", "last_active_at"])
            .where("project_id", "=", project.id)
            .where("vm_id", "=", row.vm_id)
            .where("status", "not in", ["archived", "failed"])
            .orderBy("created_at", "asc")
            .execute(),
        ]);
        return {
          binding: toProjectVmBindingRecord(row),
          vm: toVmInstanceRecord(vm),
          sharedProjects: shared.map((item) => ({
            id: item.id,
            name: item.name,
            isPrimary: item.is_primary === 1,
            archivedAt: item.archived_at,
          })),
          sharedActiveTaskCount: sharedActive.length,
          activeWorkers: workers.map((worker) => ({
            workerId: worker.id,
            projectId: project.id,
            projectName: project.name,
            status: worker.status as ProjectBindingView["activeWorkers"][number]["status"],
            currentTaskId: worker.current_task_id,
            lastActiveAt: worker.last_active_at,
          })),
          queueDepth: active.length,
        };
      }),
    );
    return {
      project,
      bindings,
      conversationCount: conversations.length,
      activeTaskCount: activeTasks.length,
      activeWorkerCount: bindings.reduce((total, item) => total + item.activeWorkers.length, 0),
    };
  }

  private async requireProject(
    projectId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<ProjectRecord> {
    const row = await executor
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`项目不存在：${projectId}`);
    return toProjectRecord(row);
  }

  private async requireActive(projectId: string): Promise<ProjectRecord> {
    const project = await this.requireProject(projectId);
    if (project.archivedAt) throw new PersistenceError("conflict", "已归档项目不能修改");
    return project;
  }

  private async record(
    projectId: string,
    type: string,
    payload: unknown,
    action: string,
    now: string,
    trx: DatabaseExecutor,
  ): Promise<void> {
    await trx
      .insertInto("project_activities")
      .values({
        project_id: projectId,
        type,
        payload_json: JSON.stringify(payload),
        created_at: now,
      })
      .execute();
    await this.outbox.append("project.changed", { projectId, action }, now, trx);
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 80)
    throw new PersistenceError("validation_failed", "项目名称必须为 1～80 个字符");
  return name;
}

function normalizeDescription(value: unknown): string {
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length > 2000)
    throw new PersistenceError("validation_failed", "项目描述不能超过 2000 个字符");
  return description;
}

function normalizeWorkspace(value: unknown): { defaultGuestWorkspacePath: string } {
  if (value === undefined) return { defaultGuestWorkspacePath: "/home/worker/workspace" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceError("validation_failed", "workspaceConfig 必须是对象");
  }
  const path = (value as { defaultGuestWorkspacePath?: unknown }).defaultGuestWorkspacePath;
  if (typeof path !== "string" || !path.trim()) {
    throw new PersistenceError(
      "validation_failed",
      "workspaceConfig.defaultGuestWorkspacePath 必须是非空字符串",
    );
  }
  return { defaultGuestWorkspacePath: normalizeWorkspacePath(path) };
}

function normalizeWorkspacePath(value: unknown): string {
  try {
    return normalizeGuestWorkspacePath(typeof value === "string" ? value : "");
  } catch (error) {
    throw new PersistenceError(
      "validation_failed",
      error instanceof Error ? error.message : "Guest 工作目录无效",
    );
  }
}

function normalizeWorkspacePathForVm(value: unknown, osFamily: string): string {
  const normalized = normalizeWorkspacePath(value);
  const windowsPath = isWindowsGuestPath(normalized);
  if ((osFamily === "windows" && !windowsPath) || (osFamily === "linux" && windowsPath)) {
    throw new PersistenceError(
      "validation_failed",
      "Guest 工作目录必须与 VM OS 匹配：Windows 使用盘符绝对路径，Linux 使用 POSIX 绝对路径",
    );
  }
  return normalized;
}
