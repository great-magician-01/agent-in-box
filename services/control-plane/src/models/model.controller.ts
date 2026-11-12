import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import type {
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelProviderUpsert,
  ModelProviderView,
  ModelRequestRecord,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { SettingsService } from "../settings/settings.service";
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
    private readonly settings: SettingsService,
  ) {}

  @Get("providers")
  listProviders(): Promise<ModelProviderView[]> {
    return this.providers.list();
  }

  @Get("configuration")
  async configuration(): Promise<ModelConfigurationView> {
    const [providers, selection] = await Promise.all([
      this.providers.list(),
      this.settings.modelSelection(),
    ]);
    return {
      providers,
      selection,
      routerLockedByEnv: routerSelectionLockedByEnv(),
    };
  }

  @Put("configuration")
  async updateConfiguration(
    @Body() input: ModelConfigurationUpdate,
  ): Promise<ModelConfigurationView> {
    if (routerSelectionLockedByEnv() && input?.router !== undefined) {
      throw new PersistenceError(
        "conflict",
        "Router 模型由 AGENT_IN_BOX_ROUTER_PROVIDER/MODEL 环境变量锁定，不能在界面切换",
      );
    }
    const patch: {
      worker?: { providerId: string; model: string } | null;
      router?: { providerId: string; model: string } | null;
    } = {};
    if (input?.worker !== undefined) {
      if (input.worker !== null) await this.providers.validateSelection(input.worker);
      patch.worker = input.worker;
    }
    if (input?.router !== undefined) {
      if (input.router !== null) await this.providers.validateSelection(input.router);
      patch.router = input.router;
    }
    const selection = await this.settings.updateModelSelection(patch);
    return {
      providers: await this.providers.list(),
      selection,
      routerLockedByEnv: routerSelectionLockedByEnv(),
    };
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

function routerSelectionLockedByEnv(): boolean {
  return Boolean(
    process.env.AGENT_IN_BOX_ROUTER_PROVIDER?.trim() ||
    process.env.AGENT_IN_BOX_ROUTER_MODEL?.trim(),
  );
}
