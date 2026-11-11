import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import type {
  CreateVmSnapshotRequest,
  RestoreVmSnapshotRequest,
  VmConsole,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  VmSnapshotImpact,
  VmSnapshotRecord,
} from "@agent-in-box/protocol";
import { SnapshotService } from "./snapshot.service";
import { VmService } from "./vm.service";

@Controller("/api/v1/vms")
export class VmController {
  constructor(
    private readonly vms: VmService,
    private readonly snapshots: SnapshotService,
  ) {}

  @Get()
  list(): Promise<VmListResponse> {
    return this.vms.list();
  }

  @Post()
  create(@Body() input: VmCreateRequest): Promise<VmInstanceView> {
    return this.vms.create(input);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<VmInstanceView> {
    return this.vms.get(id);
  }

  @Post(":id/start")
  start(@Param("id") id: string): Promise<VmInstanceView> {
    return this.vms.start(id);
  }

  @Post(":id/stop")
  stop(
    @Param("id") id: string,
    @Body() body: { mode?: "graceful" | "force" },
  ): Promise<VmInstanceView> {
    return this.vms.stop(id, body?.mode ?? "graceful");
  }

  @Post(":id/suspend")
  suspend(@Param("id") id: string): Promise<VmInstanceView> {
    return this.vms.suspend(id);
  }

  @Post(":id/resume")
  resume(@Param("id") id: string): Promise<VmInstanceView> {
    return this.vms.resume(id);
  }

  @Get(":id/console")
  console(@Param("id") id: string): Promise<VmConsole> {
    return this.vms.console(id);
  }

  @Delete(":id")
  delete(@Param("id") id: string): Promise<{ deleted: true; vmId: string }> {
    return this.vms.delete(id);
  }

  @Get(":id/snapshots")
  listSnapshots(@Param("id") id: string): Promise<VmSnapshotRecord[]> {
    return this.snapshots.list(id);
  }

  @Post(":id/snapshots")
  createSnapshot(
    @Param("id") id: string,
    @Body() body: CreateVmSnapshotRequest,
  ): Promise<VmSnapshotRecord> {
    return this.snapshots.create(id, body ?? {});
  }

  @Get(":id/snapshots/:snapshotId/impact")
  snapshotImpact(
    @Param("id") id: string,
    @Param("snapshotId") snapshotId: string,
  ): Promise<VmSnapshotImpact> {
    return this.snapshots.impact(id, snapshotId);
  }

  @Post(":id/snapshots/:snapshotId/restore")
  restoreSnapshot(
    @Param("id") id: string,
    @Param("snapshotId") snapshotId: string,
    @Body() body: RestoreVmSnapshotRequest,
  ): Promise<VmSnapshotImpact> {
    return this.snapshots.restore(id, snapshotId, body ?? {});
  }
}
