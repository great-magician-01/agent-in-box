import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import type {
  BotAccessCodeRequest,
  BotAccessCodeView,
  BotAccountCreateRequest,
  BotAccountRecord,
  BotAccountTestRequest,
  BotAccountTestResult,
  BotAccountUpdateRequest,
  BotChatRecord,
  BotChatUpsertRequest,
  BotDeviceUpdateRequest,
  BotIdentityRecord,
  BotIdentityUpsertRequest,
  BotOutboundTestRequest,
  BotOverview,
  BotPlatform,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { BotAccountService } from "./bot-account.service";
import { BotConnectorService } from "./bot-connector.service";
import { BotIdentityService } from "./bot-identity.service";
import { BotIngressDispatcherService } from "./bot-ingress.service";
import { BotNotificationService } from "./bot-notification.service";
import { BotOutboundService } from "./bot-outbound.service";
import { BotOverviewService } from "./bot-overview.service";
import { isBotPlatform } from "./bot-support";

@Controller("/api/v1/bots")
export class BotController {
  constructor(
    private readonly overviewService: BotOverviewService,
    private readonly accounts: BotAccountService,
    private readonly identities: BotIdentityService,
    private readonly connectors: BotConnectorService,
    private readonly ingress: BotIngressDispatcherService,
    private readonly outbound: BotOutboundService,
    private readonly notifications: BotNotificationService,
  ) {}

  @Get()
  overview(): Promise<BotOverview> {
    return this.overviewService.overview();
  }

  @Post("device")
  async device(@Body() body: BotDeviceUpdateRequest): Promise<BotOverview> {
    await this.accounts.setActiveDevice(body?.active === true);
    await this.connectors.tick();
    return this.overviewService.overview();
  }

  @Post("accounts")
  async create(@Body() body: BotAccountCreateRequest): Promise<BotAccountRecord> {
    const account = await this.accounts.create(body);
    if (body?.secret) {
      const result = await this.connectors.testAccount(account, body.secret);
      if (!result.ok) {
        await this.accounts.setRuntimeState(account.id, "degraded", {
          error: result.lastError ?? "机器人连接测试失败",
        });
        return this.accounts.get(account.id);
      }
    }
    await this.connectors.tick();
    return this.accounts.get(account.id);
  }

  @Patch("accounts/:id")
  async update(
    @Param("id") id: string,
    @Body() body: BotAccountUpdateRequest,
  ): Promise<BotAccountRecord> {
    const account = await this.accounts.update(id, body ?? {});
    if (body?.secret) {
      const result = await this.connectors.testAccount(account, body.secret);
      if (result.ok) {
        // Force a new connection so a rotated secret is actually picked up.
        await this.connectors.disconnect(id).catch(() => undefined);
      } else {
        await this.accounts.setRuntimeState(account.id, "degraded", {
          error: result.lastError ?? "机器人连接测试失败",
        });
      }
    }
    await this.connectors.tick();
    return this.accounts.get(id);
  }

  @Delete("accounts/:id")
  async remove(@Param("id") id: string): Promise<{ deleted: true; accountId: string }> {
    await this.connectors.disconnect(id).catch(() => undefined);
    await this.accounts.delete(id);
    return { deleted: true, accountId: id };
  }

  @Post("accounts/:id/test")
  async test(
    @Param("id") id: string,
    @Body() body: BotAccountTestRequest = {},
  ): Promise<BotAccountTestResult> {
    const account = await this.accounts.get(id);
    const result = await this.connectors.testAccount(account, body?.secret);
    await this.accounts.setRuntimeState(account.id, result.state, { error: result.lastError });
    return {
      ok: result.ok,
      accountId: id,
      state: result.state,
      lastError: result.lastError,
      checkedAt: new Date().toISOString(),
    };
  }

  @Post("accounts/:id/reconnect")
  async reconnect(@Param("id") id: string): Promise<BotAccountRecord> {
    await this.connectors.reconnect(id);
    return this.accounts.get(id);
  }

  @Post("accounts/:id/disconnect")
  async disconnect(@Param("id") id: string): Promise<BotAccountRecord> {
    await this.connectors.disconnect(id);
    return this.accounts.get(id);
  }

  @Post("accounts/:id/messages")
  async sendTest(
    @Param("id") id: string,
    @Body() body: BotOutboundTestRequest,
  ): Promise<{ queued: number }> {
    const queued = await this.outbound.sendTest(id, body?.conversationId ?? "", body?.text ?? "");
    await this.outbound.flush();
    return { queued };
  }

  @Put("identities/:platform/:platformUserId")
  async upsertIdentity(
    @Param("platform") platform: string,
    @Param("platformUserId") platformUserId: string,
    @Body() body: BotIdentityUpsertRequest,
  ): Promise<BotIdentityRecord> {
    return this.identities.upsertIdentity(requirePlatform(platform), {
      ...body,
      platformUserId,
    });
  }

  @Delete("identities/:platform/:platformUserId")
  async deleteIdentity(
    @Param("platform") platform: string,
    @Param("platformUserId") platformUserId: string,
  ): Promise<{ deleted: true }> {
    await this.identities.deleteIdentity(requirePlatform(platform), platformUserId);
    return { deleted: true };
  }

  @Put("chats")
  upsertChat(@Body() body: BotChatUpsertRequest): Promise<BotChatRecord> {
    return this.identities.upsertChat(body);
  }

  @Delete("chats/:platform/:conversationId")
  async deleteChat(
    @Param("platform") platform: string,
    @Param("conversationId") conversationId: string,
  ): Promise<{ deleted: true }> {
    await this.identities.deleteChat(requirePlatform(platform), conversationId);
    return { deleted: true };
  }

  @Post("access-codes")
  createAccessCode(@Body() body: BotAccessCodeRequest = {}): Promise<BotAccessCodeView> {
    return this.identities.createAccessCode(body ?? {});
  }

  @Post("reconcile")
  async reconcile(): Promise<{
    processedIngress: number;
    sentOutbound: number;
    consumedNotifications: number;
  }> {
    const processedIngress = await this.ingress.processAvailable(20);
    const consumedNotifications = await this.notifications.consume(200);
    const sentOutbound = await this.outbound.flush();
    return { processedIngress, sentOutbound, consumedNotifications };
  }
}

function requirePlatform(value: string): BotPlatform {
  if (!isBotPlatform(value)) {
    throw new PersistenceError("bad_request", "机器人平台必须是 feishu 或 qq");
  }
  return value;
}
