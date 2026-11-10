import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type {
  VmConsole,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
} from "@agent-in-box/protocol";
import { VmService } from "./vm.service";

@Controller("/api/v1/vms")
export class VmController {
  constructor(private readonly vms: VmService) {}

  @Get()
  list(): Promise<VmListResponse> {
    return this.vms.list();
  }

  @Post()
  create(@Body() input: VmCreateRequest): Promise<VmInstanceView> {
    return this.vms.create(input);
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
}
