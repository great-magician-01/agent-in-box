import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  GuestHealthState,
  SupervisorVmState,
  VmConsole,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  VmPowerState,
  SupervisorAvailability,
} from "@agent-in-box/protocol";
import type { Kysely } from "kysely";
import { ImageService } from "../images/image.service";
import { DatabaseService } from "../persistence/database.service";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import { toTaskRecord, toVmInstanceRecord } from "../persistence/mappers";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { directoryStats } from "../storage/fs-utils";
import { SupervisorClient } from "./supervisor.client";

const GIB = 1024 * 1024 * 1024;
const ACTIVE_TASK_STATUSES = [
  "created",
  "waiting_resources",
  "waiting_vm",
  "queued",
  "running",
  "waiting_approval",
  "blocked",
] as const;

export const VM_SERVICE_OPTIONS = Symbol("AGENT_IN_BOX_VM_SERVICE_OPTIONS");
export interface VmServiceOptions {
  guestFetchImpl?: typeof fetch;
  guestTimeoutMs?: number;
}

@Injectable()
export class VmService {
  private readonly guestFetch: typeof fetch;
  private readonly guestTimeoutMs: number;

  constructor(
    private readonly database: DatabaseService,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly images: ImageService,
    private readonly supervisor: SupervisorClient,
    @Optional() @Inject(VM_SERVICE_OPTIONS) options: VmServiceOptions = {},
  ) {
    this.guestFetch = options.guestFetchImpl ?? fetch;
    this.guestTimeoutMs = options.guestTimeoutMs ?? 1000;
  }

  async list(): Promise<VmListResponse> {
    const rows = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    let states = new Map<string, SupervisorVmState>();
    let availability: SupervisorAvailability = { available: true, message: null };
    try {
      states = new Map((await this.supervisor.list()).map((state) => [state.id, state]));
    } catch (error) {
      availability = {
        available: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const items = await Promise.all(
      rows.map(async (row) => {
        let runtime = states.get(row.id) ?? null;
        if (availability.available) {
          if (!runtime) {
            await this.persistState(
              row.id,
              "error",
              "unknown",
              null,
              "Supervisor 中缺少 VM 元数据",
            );
          } else {
            runtime = await this.withGuestHealth(runtime);
            await this.persistState(row.id, runtime.powerState, runtime.guestHealth, runtime, null);
          }
        }
        return this.view(row.id, runtime);
      }),
    );
    return { items, supervisor: availability };
  }

  async create(input: VmCreateRequest): Promise<VmInstanceView> {
    if (typeof input !== "object" || input === null) {
      throw new PersistenceError("validation_failed", "VM 创建参数无效");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 64) {
      throw new PersistenceError("validation_failed", "VM 名称必须为 1～64 个字符");
    }
    if (!Number.isInteger(input.cpuCount) || input.cpuCount < 1 || input.cpuCount > 32) {
      throw new PersistenceError("validation_failed", "CPU 必须为 1～32 核");
    }
    if (!Number.isInteger(input.memoryGb) || input.memoryGb < 1 || input.memoryGb > 64) {
      throw new PersistenceError("validation_failed", "内存必须为 1～64 GiB 整数");
    }
    if (!Number.isInteger(input.diskGb) || input.diskGb < 1 || input.diskGb > 2048) {
      throw new PersistenceError("validation_failed", "磁盘必须为 1～2048 GiB 整数");
    }
    if (typeof input.imageId !== "string" || !input.imageId) {
      throw new PersistenceError("validation_failed", "必须选择一个镜像");
    }
    const image = await this.images.get(input.imageId);
    if (image.osFamily !== "linux") {
      throw new PersistenceError("validation_failed", "阶段 3 仅允许创建 Linux Guest");
    }
    if (image.status !== "available" || !image.localPath || !image.verifiedAt) {
      throw new PersistenceError("conflict", "只有校验通过的 Available 镜像可以创建 VM");
    }
    const seedImagePath = input.seedImagePath?.trim() || image.seedLocalPath || "";
    if (seedImagePath) {
      if (!path.isAbsolute(seedImagePath)) {
        throw new PersistenceError("validation_failed", "NoCloud Seed 必须使用绝对路径");
      }
      const info = await lstat(seedImagePath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new PersistenceError("validation_failed", "NoCloud Seed 必须是可读取的普通文件");
      }
    }

    const id = randomUUID();
    const runtime = await this.supervisor.create({
      id,
      name,
      baseImagePath: image.localPath,
      seedImagePath,
      cpuCount: input.cpuCount,
      memoryMb: input.memoryGb * 1024,
      diskSizeGb: input.diskGb,
      desktop: true,
      qmpPort: 0,
      sshHostPort: 0,
      guestHostPort: 0,
      vncDisplay: 0,
    });
    const now = nowIso();
    await this.db
      .insertInto("vm_instances")
      .values({
        id,
        name,
        image_id: image.id,
        os_family: "linux",
        cpu_count: input.cpuCount,
        memory_bytes: input.memoryGb * GIB,
        disk_bytes: input.diskGb * GIB,
        storage_root: path.join(this.database.layout.vms, id),
        power_state: "stopped",
        guest_health: "unknown",
        created_at: now,
        last_started_at: null,
      })
      .execute();
    return this.view(id, runtime);
  }

  start(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.start(id));
  }

  stop(id: string, mode: "graceful" | "force" = "graceful"): Promise<VmInstanceView> {
    if (mode !== "graceful" && mode !== "force") {
      throw new PersistenceError("validation_failed", "停止模式必须是 graceful 或 force");
    }
    return this.action(id, () => this.supervisor.stop(id, mode));
  }

  suspend(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.suspend(id));
  }

  resume(id: string): Promise<VmInstanceView> {
    return this.action(id, () => this.supervisor.resume(id));
  }

  async console(id: string): Promise<VmConsole> {
    const vm = await this.requireVm(id);
    const runtime = await this.withGuestHealth(await this.supervisor.get(id));
    await this.persistState(id, runtime.powerState, runtime.guestHealth, runtime, null);
    if (runtime.powerState !== "running" && runtime.powerState !== "suspended") {
      throw new PersistenceError("conflict", "只有运行或休眠中的 VM 可以连接控制台");
    }
    return {
      vmId: vm.id,
      consoleUrl: await this.supervisor.console(id),
      message:
        "QEMU VNC 仅绑定回环地址。请通过阶段 4 的 noVNC 会话建立连接；人工输入由统一 Execution Lease 保护。",
    };
  }

  private async action(
    id: string,
    operation: () => Promise<SupervisorVmState>,
  ): Promise<VmInstanceView> {
    await this.requireVm(id);
    try {
      const state = await this.withGuestHealth(await operation());
      await this.persistState(id, state.powerState, state.guestHealth, state, null);
      return this.view(id, state);
    } catch (error) {
      await this.persistState(
        id,
        "error",
        "unknown",
        null,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async getRecord(id: string) {
    return this.requireVm(id);
  }

  private async requireVm(id: string) {
    const row = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundError(`VM 不存在：${id}`);
    }
    return toVmInstanceRecord(row);
  }

  private async withGuestHealth(state: SupervisorVmState): Promise<SupervisorVmState> {
    let guestHealth: GuestHealthState = "unknown";
    if (state.powerState === "running" && state.guestHostPort > 0) {
      try {
        const response = await this.guestFetch(`http://127.0.0.1:${state.guestHostPort}/healthz`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.guestTimeoutMs),
        });
        guestHealth = response.ok ? "healthy" : "unreachable";
      } catch {
        guestHealth = "unreachable";
      }
    } else if (state.powerState === "running") {
      guestHealth = "unreachable";
    }
    return { ...state, guestHealth };
  }

  private async persistState(
    id: string,
    powerState: VmPowerState,
    guestHealth: GuestHealthState,
    runtime: SupervisorVmState | null,
    lastError: string | null,
  ): Promise<void> {
    const current = await this.db
      .selectFrom("vm_instances")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!current) {
      return;
    }
    const now = nowIso();
    const changed = current.power_state !== powerState;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("vm_instances")
        .set({
          power_state: powerState,
          guest_health: guestHealth,
          last_started_at:
            powerState === "running" && current.power_state !== "running"
              ? now
              : current.last_started_at,
        })
        .where("id", "=", id)
        .execute();
      if (changed) {
        await trx
          .insertInto("outbox")
          .values({
            topic: "vm.power_changed",
            payload_json: JSON.stringify({
              vmId: id,
              from: current.power_state,
              to: powerState,
              ...(lastError ? { error: lastError } : {}),
            }),
            created_at: now,
            published_at: null,
            attempts: 0,
            last_error: null,
          })
          .execute();
      }
    });
  }

  private async view(id: string, runtime: SupervisorVmState | null): Promise<VmInstanceView> {
    const vm = await this.requireVm(id);
    const [bindings, task, usage] = await Promise.all([
      this.db
        .selectFrom("project_vm_bindings")
        .innerJoin("projects", "projects.id", "project_vm_bindings.project_id")
        .select([
          "projects.id as id",
          "projects.name as name",
          "project_vm_bindings.is_primary as is_primary",
        ])
        .where("project_vm_bindings.vm_id", "=", id)
        .execute(),
      this.db
        .selectFrom("tasks")
        .selectAll()
        .where("vm_id", "=", id)
        .where("status", "in", ACTIVE_TASK_STATUSES)
        .orderBy("priority", "desc")
        .orderBy("created_at", "asc")
        .limit(1)
        .executeTakeFirst(),
      directoryStats(vm.storageRoot).catch(() => ({ bytes: 0, files: 0 })),
    ]);
    return {
      vm,
      runtime,
      diskUsageBytes: usage.bytes,
      boundProjects: bindings.map((binding) => ({
        id: binding.id,
        name: binding.name,
        isPrimary: binding.is_primary === 1,
      })),
      currentTask: task
        ? {
            id: task.id,
            objective: task.objective,
            status: toTaskRecord(task).status,
          }
        : null,
    };
  }
}
