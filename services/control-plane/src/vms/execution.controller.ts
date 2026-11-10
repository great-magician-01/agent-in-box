import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type {
  ExecutionLeaseView,
  VmConsoleSession,
  VmControlView,
  WorkerLeaseRequest,
} from "@agent-in-box/protocol";
import { LeaseService } from "../persistence/services/lease-service";
import { PersistenceError } from "../persistence/errors";
import { ConsoleService } from "./console.service";
import { VmService } from "./vm.service";

@Controller("/api/v1/vms")
export class ExecutionController {
  constructor(
    private readonly vms: VmService,
    private readonly leases: LeaseService,
    private readonly consoles: ConsoleService,
  ) {}

  @Get(":id/control")
  async control(@Param("id") id: string): Promise<VmControlView> {
    await this.vms.getRecord(id);
    return this.leases.control(id);
  }

  @Post(":id/console/sessions")
  openConsole(@Param("id") id: string): Promise<VmConsoleSession> {
    return this.consoles.openSession(id);
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
