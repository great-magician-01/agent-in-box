import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type {
  ExecutionLeaseView,
  VmConsoleSession,
  VmControlView,
  WorkerLeaseRequest,
} from "@agent-in-box/protocol";
import { LeaseService } from "../persistence/services/lease-service";
import { TaskService } from "../persistence/services/task-service";
import { PersistenceError } from "../persistence/errors";
import { ConsoleService } from "./console.service";
import { VmService } from "./vm.service";

@Controller("/api/v1/vms")
export class ExecutionController {
  constructor(
    private readonly vms: VmService,
    private readonly leases: LeaseService,
    private readonly consoles: ConsoleService,
    private readonly tasks: TaskService,
  ) {}

  @Get(":id/control")
  async control(@Param("id") id: string): Promise<VmControlView> {
    await this.vms.getRecord(id);
    return this.leases.control(id);
  }

  @Post(":id/console/sessions")
  openConsole(
    @Param("id") id: string,
    @Body() input?: { viewOnly?: boolean },
  ): Promise<VmConsoleSession> {
    if (input?.viewOnly !== undefined && typeof input.viewOnly !== "boolean") {
      throw new PersistenceError("validation_failed", "viewOnly 必须是布尔值");
    }
    return this.consoles.openSession(id, { viewOnly: input?.viewOnly === true });
  }

  @Post(":id/lease/worker")
  async acquireWorker(
    @Param("id") id: string,
    @Body() input: WorkerLeaseRequest,
  ): Promise<ExecutionLeaseView> {
    await this.vms.getRecord(id);
    if (typeof input?.taskId !== "string" || !input.taskId.trim() || input.taskId.length > 128) {
      throw new PersistenceError("validation_failed", "Worker Lease 必须关联有效的任务 ID");
    }
    const task = await this.tasks.get(input.taskId.trim()).catch(() => null);
    if (!task || task.vmId !== id) {
      throw new PersistenceError("validation_failed", "任务不存在或不属于该 VM");
    }
    if (task.status !== "running") {
      throw new PersistenceError("conflict", "只有运行中的任务可以申请 Worker Lease");
    }
    return this.leases.acquire({
      vmId: id,
      owner: "worker",
      taskId: input.taskId.trim(),
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
  }

  @Post(":id/lease/heartbeat")
  async heartbeat(
    @Param("id") id: string,
    @Body() input: { leaseId?: string; ttlMs?: number },
  ): Promise<ExecutionLeaseView> {
    if (typeof input?.leaseId !== "string" || !input.leaseId) {
      throw new PersistenceError("validation_failed", "leaseId 不能为空");
    }
    return this.leases.renewForVm(id, input.leaseId, input.ttlMs ?? 15_000);
  }

  @Post(":id/lease/release")
  async release(
    @Param("id") id: string,
    @Body() input: { leaseId?: string },
  ): Promise<{ released: boolean }> {
    if (typeof input?.leaseId !== "string" || !input.leaseId) {
      throw new PersistenceError("validation_failed", "leaseId 不能为空");
    }
    return { released: await this.leases.release(id, input.leaseId) };
  }
}
