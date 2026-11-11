import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import type {
  ModelProviderUpsert,
  ModelProviderView,
  ModelRequestRecord,
} from "@agent-in-box/protocol";
import { ModelBrokerService } from "./model-broker.service";
import { ModelProviderService } from "./model-provider.service";
import { ModelTokenService } from "./model-token.service";

/**
 * Provider configuration contains no secret. The long-lived key stays in the
 * Electron safeStorage credential bridge and is never returned by this route.
 */
@Controller("/api/v1/models")
export class ModelController {
  constructor(
    private readonly providers: ModelProviderService,
    private readonly broker: ModelBrokerService,
    private readonly tokens: ModelTokenService,
  ) {}

  @Get("providers")
  listProviders(): Promise<ModelProviderView[]> {
    return this.providers.list();
  }

  @Put("providers/:id")
  upsertProvider(
    @Param("id") id: string,
    @Body() input: ModelProviderUpsert,
  ): Promise<ModelProviderView> {
    return this.providers.upsert(id, input);
  }

  @Get("requests")
  requests(
    @Query("workerId") workerId?: string,
    @Query("taskId") taskId?: string,
    @Query("limit") limit?: string,
  ): Promise<ModelRequestRecord[]> {
    const parsed = limit === undefined ? 50 : Number(limit);
    return this.broker.listRequests({
      ...(workerId ? { workerId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
    });
  }

  @Post("tokens/:id/revoke")
  async revoke(
    @Param("id") id: string,
    @Body() body?: { reason?: string },
  ): Promise<{ revoked: boolean }> {
    return {
      revoked: await this.tokens.revoke(id, body?.reason?.trim() || "manual_revoke"),
    };
  }
}
