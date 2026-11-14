import { Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import type { BootstrapState } from "@agent-in-box/protocol";
import { BootstrapService } from "./bootstrap.service";

@Controller("api/v1/bootstrap")
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get()
  state(): Promise<BootstrapState> {
    return this.bootstrap.state();
  }

  @Post("start")
  @HttpCode(HttpStatus.OK)
  start(): Promise<BootstrapState> {
    return this.bootstrap.start();
  }

  @Post("retry")
  @HttpCode(HttpStatus.OK)
  retry(): Promise<BootstrapState> {
    return this.bootstrap.start();
  }

  @Post("cancel")
  @HttpCode(HttpStatus.OK)
  cancel(): Promise<BootstrapState> {
    return this.bootstrap.cancel();
  }
}
