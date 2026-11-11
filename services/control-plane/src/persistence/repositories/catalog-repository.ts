import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ConversationRecord,
  ImageRecord,
  OsFamily,
  ProjectRecord,
  ProjectVmBindingRecord,
  VmInstanceRecord,
} from "@agent-in-box/protocol";
import { nowIso } from "../time";
import {
  toConversationRecord,
  toImageRecord,
  toProjectRecord,
  toProjectVmBindingRecord,
  toVmInstanceRecord,
} from "../mappers";
import { NotFoundError, PersistenceError } from "../errors";
import type { DatabaseSchema } from "../schema";
import { KYSELY } from "../tokens";

export interface CreateImageInput {
  name: string;
  osFamily: OsFamily;
  osVersion: string;
  architecture: string;
  version: string;
  sizeBytes: number;
  checksum: string;
  localPath?: string | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface CreateVmInput {
  name: string;
  imageId: string;
  osFamily: OsFamily;
  cpuCount: number;
  memoryBytes: number;
  diskBytes: number;
  storageRoot: string;
}

export interface CreateConversationInput {
  kind: "router" | "project";
  projectId: string | null;
  title: string;
}

export interface BindVmInput {
  projectId: string;
  vmId: string;
  guestWorkspacePath: string;
  isPrimary: boolean;
}

export class CatalogRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async createImage(input: CreateImageInput): Promise<ImageRecord> {
    const now = nowIso();
    const record: ImageRecord = {
      id: randomUUID(),
      name: input.name,
      osFamily: input.osFamily,
      osVersion: input.osVersion,
      architecture: input.architecture,
      version: input.version,
      status: "available",
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      localPath: input.localPath ?? null,
      createdAt: now,
      verifiedAt: null,
      sourceUrl: "",
      fileName: "",
      downloadedBytes: 0,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
      seedLocalPath: null,
    };

    await this.db
      .insertInto("images")
      .values({
        id: record.id,
        name: record.name,
        os_family: record.osFamily,
        os_version: record.osVersion,
        architecture: record.architecture,
        version: record.version,
        status: record.status,
        size_bytes: record.sizeBytes,
        checksum: record.checksum,
        local_path: record.localPath,
        created_at: record.createdAt,
        verified_at: null,
        source_url: "",
        file_name: "",
        downloaded_bytes: 0,
        error_code: null,
        error_message: null,
        updated_at: now,
        seed_local_path: null,
        manifest_json: "",
      })
      .execute();

    return record;
  }

  async getImage(id: string): Promise<ImageRecord | undefined> {
    const row = await this.db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toImageRecord(row) : undefined;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const now = nowIso();
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      defaultVmBindingId: null,
      workspaceConfig: { defaultGuestWorkspacePath: "/home/worker/workspace" },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    await this.db
      .insertInto("projects")
      .values({
        id: record.id,
        name: record.name,
        description: record.description,
        default_vm_binding_id: null,
        workspace_config_json: JSON.stringify(record.workspaceConfig),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        archived_at: null,
      })
      .execute();

    return record;
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = await this.db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toProjectRecord(row) : undefined;
  }

  async listProjects(limit = 50): Promise<ProjectRecord[]> {
    const rows = await this.db
      .selectFrom("projects")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toProjectRecord);
  }

  async createVm(input: CreateVmInput): Promise<VmInstanceRecord> {
    const record: VmInstanceRecord = {
      id: randomUUID(),
      name: input.name,
      imageId: input.imageId,
      osFamily: input.osFamily,
      cpuCount: input.cpuCount,
      memoryBytes: input.memoryBytes,
      diskBytes: input.diskBytes,
      storageRoot: input.storageRoot,
      powerState: "stopped",
      guestHealth: "unknown",
      createdAt: nowIso(),
      lastStartedAt: null,
    };

    await this.db
      .insertInto("vm_instances")
      .values({
        id: record.id,
        name: record.name,
        image_id: record.imageId,
        os_family: record.osFamily,
        cpu_count: record.cpuCount,
        memory_bytes: record.memoryBytes,
        disk_bytes: record.diskBytes,
        storage_root: record.storageRoot,
        power_state: record.powerState,
        guest_health: record.guestHealth,
        created_at: record.createdAt,
        last_started_at: null,
      })
      .execute();

    return record;
  }

  async getVm(id: string): Promise<VmInstanceRecord | undefined> {
    const row = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toVmInstanceRecord(row) : undefined;
  }

  async listVms(limit = 50): Promise<VmInstanceRecord[]> {
    const rows = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toVmInstanceRecord);
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    if (input.kind === "project" && input.projectId === null) {
      throw new PersistenceError("validation_failed", "Project conversations require a projectId");
    }

    const now = nowIso();
    const record: ConversationRecord = {
      id: randomUUID(),
      kind: input.kind,
      projectId: input.projectId,
      title: input.title,
      createdAt: now,
      lastMessageAt: now,
    };

    await this.db
      .insertInto("conversations")
      .values({
        id: record.id,
        kind: record.kind,
        project_id: record.projectId,
        title: record.title,
        created_at: record.createdAt,
        last_message_at: record.lastMessageAt,
      })
      .execute();

    return record;
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const row = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toConversationRecord(row) : undefined;
  }

  async bindVm(input: BindVmInput): Promise<ProjectVmBindingRecord> {
    if (!(await this.getProject(input.projectId))) {
      throw new NotFoundError(`Project not found: ${input.projectId}`);
    }
    if (!(await this.getVm(input.vmId))) {
      throw new NotFoundError(`VM not found: ${input.vmId}`);
    }

    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("project_vm_bindings")
        .selectAll()
        .where("project_id", "=", input.projectId)
        .where("vm_id", "=", input.vmId)
        .executeTakeFirst();

      if (existing) {
        return toProjectVmBindingRecord(existing);
      }

      if (input.isPrimary) {
        await trx
          .updateTable("project_vm_bindings")
          .set({ is_primary: 0 })
          .where("project_id", "=", input.projectId)
          .execute();
      }

      const binding: ProjectVmBindingRecord = {
        id: randomUUID(),
        projectId: input.projectId,
        vmId: input.vmId,
        guestWorkspacePath: input.guestWorkspacePath,
        isPrimary: input.isPrimary,
        createdAt: nowIso(),
      };

      await trx
        .insertInto("project_vm_bindings")
        .values({
          id: binding.id,
          project_id: binding.projectId,
          vm_id: binding.vmId,
          guest_workspace_path: binding.guestWorkspacePath,
          is_primary: binding.isPrimary ? 1 : 0,
          created_at: binding.createdAt,
        })
        .execute();

      if (binding.isPrimary) {
        await trx
          .updateTable("projects")
          .set({ default_vm_binding_id: binding.id })
          .where("id", "=", binding.projectId)
          .execute();
      }

      return binding;
    });
  }

  async listBindings(projectId: string): Promise<ProjectVmBindingRecord[]> {
    const rows = await this.db
      .selectFrom("project_vm_bindings")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toProjectVmBindingRecord);
  }
}
