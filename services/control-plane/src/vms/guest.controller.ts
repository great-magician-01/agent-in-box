import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type {
  GuestActionRequest,
  GuestActionResult,
  GuestAgentCapabilities,
  GuestDesktopInfo,
  GuestHeartbeat,
  GuestScreenshot,
  GuestVersionHandshake,
} from "@agent-in-box/protocol";
import { GuestService } from "./guest.service";

@Controller("/api/v1/vms")
export class GuestController {
  constructor(private readonly guest: GuestService) {}

  @Get(":id/guest/heartbeat")
  heartbeat(@Param("id") id: string): Promise<GuestHeartbeat> {
    return this.guest.heartbeat(id);
  }

  @Get(":id/guest/capabilities")
  capabilities(@Param("id") id: string): Promise<GuestAgentCapabilities> {
    return this.guest.capabilities(id);
  }

  @Get(":id/guest/version")
  version(@Param("id") id: string): Promise<GuestVersionHandshake> {
    return this.guest.version(id);
  }

  @Get(":id/guest/desktop")
  desktop(@Param("id") id: string): Promise<GuestDesktopInfo> {
    return this.guest.desktop(id);
  }

  @Get(":id/guest/screenshot")
  screenshot(@Param("id") id: string): Promise<GuestScreenshot> {
    return this.guest.screenshot(id);
  }

  @Post(":id/guest/actions")
  input(@Param("id") id: string, @Body() input: GuestActionRequest): Promise<GuestActionResult> {
    return this.guest.input(id, input);
  }
}
