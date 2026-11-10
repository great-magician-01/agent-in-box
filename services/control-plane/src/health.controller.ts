import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@agent-in-box/protocol";
import { buildHealthResponse } from "./health";

@Controller()
export class HealthController {
  private readonly startedAt = new Date();

  @Get("healthz")
  healthz(): HealthResponse {
    return buildHealthResponse(this.startedAt);
  }

  @Get("api/v1/health")
  health(): HealthResponse {
    return buildHealthResponse(this.startedAt);
  }
}
