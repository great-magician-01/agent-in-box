import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@agent-in-box/protocol";
import { Public } from "./auth/auth.guard";
import { buildHealthResponse } from "./health";

@Public()
@Controller()
export class HealthController {
  private readonly startedAt = new Date();
  private readonly instanceNonce = process.env.AGENT_IN_BOX_INSTANCE_NONCE?.trim() || undefined;

  @Get("healthz")
  healthz(): HealthResponse {
    return buildHealthResponse(this.startedAt, new Date(), this.instanceNonce);
  }

  @Get("api/v1/health")
  health(): HealthResponse {
    return buildHealthResponse(this.startedAt, new Date(), this.instanceNonce);
  }
}
