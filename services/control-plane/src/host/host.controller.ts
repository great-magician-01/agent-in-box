import { Controller, Get, Query } from "@nestjs/common";
import type { HostInspectionReport } from "@agent-in-box/protocol";
import { HostInspectionService } from "./host-inspection.service";

@Controller("api/v1/host")
export class HostController {
  constructor(private readonly host: HostInspectionService) {}

  @Get("inspection")
  inspect(@Query("dataRoot") dataRoot?: string): Promise<HostInspectionReport> {
    return this.host.inspect(dataRoot);
  }
}
