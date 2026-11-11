import { Controller, Get, Post } from "@nestjs/common";
import type { ResourceReconcileResult, ResourceReport } from "@agent-in-box/protocol";
import { ResourceManagerService } from "./resource-manager.service";

@Controller("/api/v1/resources")
export class ResourceController {
  constructor(private readonly resources: ResourceManagerService) {}

  @Get()
  report(): Promise<ResourceReport> {
    return this.resources.report();
  }

  @Post("reconcile")
  reconcile(): Promise<ResourceReconcileResult> {
    return this.resources.reconcile();
  }
}
