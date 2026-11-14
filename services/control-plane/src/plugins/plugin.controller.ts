import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type {
  PluginEnableRequest,
  PluginEnablementView,
  PluginRegisterRequest,
  PluginSessionSnapshot,
  PluginVersionView,
} from "@agent-in-box/protocol";
import { PluginService } from "./plugin.service";

@Controller("api/v1/plugins")
export class PluginController {
  constructor(private readonly plugins: PluginService) {}

  @Get()
  list(): Promise<PluginVersionView[]> {
    return this.plugins.list();
  }

  @Get("enablements")
  enablements(
    @Query("scopeType") scopeType?: string,
    @Query("scopeId") scopeId?: string,
  ): Promise<PluginEnablementView[]> {
    return this.plugins.enablements(scopeType, scopeId);
  }

  @Get("snapshots/:id")
  async snapshot(@Param("id") id: string): Promise<PluginSessionSnapshot | { missing: true }> {
    return (await this.plugins.snapshotById(id)) ?? { missing: true };
  }

  @Post("register")
  register(@Body() input: PluginRegisterRequest): Promise<PluginVersionView> {
    return this.plugins.register(input);
  }

  @Post(":id/enable")
  enable(
    @Param("id") id: string,
    @Body() input: PluginEnableRequest,
  ): Promise<PluginEnablementView> {
    return this.plugins.enable(id, input);
  }

  @Post(":id/disable")
  disable(
    @Param("id") id: string,
    @Body() input: { scopeType: "project" | "worker"; scopeId: string },
  ): Promise<{ disabled: true }> {
    return this.plugins.disable(id, input.scopeType, input.scopeId);
  }
}
