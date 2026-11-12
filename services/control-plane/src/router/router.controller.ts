import { Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import type {
  RouterConfigUpdate,
  RouterMessageRecord,
  RouterSendRequest,
  RouterSendResult,
  RouterToolCallRecord,
  RouterToolDefinition,
  RouterView,
} from "@agent-in-box/protocol";
import { RouterRuntimeService } from "./router-runtime.service";
import { RouterToolService } from "./router-tool.service";

@Controller("/api/v1/router")
export class RouterController {
  constructor(
    private readonly router: RouterRuntimeService,
    private readonly tools: RouterToolService,
  ) {}

  @Get()
  view(): Promise<RouterView> {
    return this.router.view();
  }

  @Get("messages")
  messages(@Query("limit") limit?: string): Promise<RouterMessageRecord[]> {
    return this.router.messages(parseLimit(limit, 100));
  }

  @Post("messages")
  send(@Body() body: RouterSendRequest): Promise<RouterSendResult> {
    return this.router.send(body?.text);
  }

  @Post("abort")
  abort(): Promise<RouterView> {
    return this.router.abort();
  }

  @Put("config")
  configure(@Body() body: RouterConfigUpdate): Promise<RouterView> {
    return this.router.configure(body);
  }

  @Get("tools")
  toolDefinitions(): RouterToolDefinition[] {
    return this.tools.definitions();
  }

  @Get("tool-calls")
  toolCalls(@Query("limit") limit?: string): Promise<RouterToolCallRecord[]> {
    return this.router.toolCalls(parseLimit(limit, 50));
  }
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
