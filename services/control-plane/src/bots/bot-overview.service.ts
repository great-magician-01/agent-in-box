import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { BotAccountView, BotOverview, BotPlatformCapability } from "@agent-in-box/protocol";
import type { DatabaseSchema } from "../persistence/schema";
import { KYSELY } from "../persistence/tokens";
import { BotAccountService } from "./bot-account.service";
import { BotIdentityService } from "./bot-identity.service";
import { toBotEventView, toBotTurnRecord } from "./bot-support";

const PLATFORM_CAPABILITIES: BotPlatformCapability[] = [
  {
    platform: "feishu",
    label: "飞书",
    longConnection: true,
    textTasks: true,
    progress: true,
    approvals: true,
    groupChat: true,
    attachments: false,
    notes: [
      "使用官方 WebSocket 长连接，无需公网 IP 或回调地址。",
      "需要在开放平台开通消息事件与发送消息权限，并把应用发布到目标企业。",
      "群聊中必须 @机器人；建议配置机器人 Open ID 以严格校验被 @ 的对象。",
      "首版只发送纯文本，不接收或发送图片、文件附件。",
    ],
  },
  {
    platform: "qq",
    label: "QQ",
    longConnection: true,
    textTasks: true,
    progress: true,
    approvals: true,
    groupChat: true,
    attachments: false,
    notes: [
      "使用 QQ Bot API v2 WebSocket Intents 和 REST，无需公网 Webhook。",
      "群聊只在 @机器人 的消息上工作；单聊与群聊的可用能力取决于机器人类型和平台权限。",
      "QQ 出站消息使用被动回复 msg_id；超出平台回复窗口的进度通知可能发送失败并显示明确错误。",
      "首版只发送纯文本，不发送富媒体附件。",
    ],
  },
];

@Injectable()
export class BotOverviewService {
  private readonly startedAt = new Date().toISOString();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly accounts: BotAccountService,
    private readonly identities: BotIdentityService,
  ) {}

  async overview(): Promise<BotOverview> {
    const deviceId = await this.accounts.ensureDeviceId();
    const activeDeviceId = await this.accounts.activeDeviceId();
    const [
      accountRecords,
      identities,
      chats,
      ingressCounts,
      outboundCounts,
      recentTurns,
      recentEvents,
    ] = await Promise.all([
      this.accounts.list(),
      this.identities.listIdentities(),
      this.identities.listChats(),
      this.ingressCounts(),
      this.outboundCounts(),
      this.db.selectFrom("bot_turns").selectAll().orderBy("created_at", "desc").limit(20).execute(),
      this.db
        .selectFrom("bot_events")
        .selectAll()
        .orderBy("updated_at", "desc")
        .limit(20)
        .execute(),
    ]);

    const accounts: BotAccountView[] = accountRecords.map((account) => ({
      ...account,
      connected: account.state === "connected",
      ingressPending: ingressCounts.get(account.id)?.pending ?? 0,
      outboundPending: outboundCounts.get(account.id)?.pending ?? 0,
      outboundFailed: outboundCounts.get(account.id)?.failed ?? 0,
    }));
    const pendingIngress = accounts.reduce((total, account) => total + account.ingressPending, 0);
    const pendingOutbound = accounts.reduce((total, account) => total + account.outboundPending, 0);
    const failedOutbound = accounts.reduce((total, account) => total + account.outboundFailed, 0);
    const failed = await this.db
      .selectFrom("bot_events")
      .select((builder) => builder.fn.countAll<number>().as("count"))
      .where("state", "=", "failed")
      .executeTakeFirst();
    return {
      deviceId,
      deviceName: this.accounts.deviceName(),
      activeDeviceId,
      thisDeviceActive: activeDeviceId === deviceId,
      computerOnline: true,
      startedAt: this.startedAt,
      accounts,
      identities,
      chats,
      recentTurns: recentTurns.map(toBotTurnRecord),
      recentEvents: recentEvents.map(toBotEventView),
      pendingIngress,
      failedIngress: Number(failed?.count ?? 0),
      pendingOutbound,
      failedOutbound,
      platforms: PLATFORM_CAPABILITIES,
    };
  }

  private async ingressCounts(): Promise<Map<string, { pending: number; failed: number }>> {
    const rows = await this.db
      .selectFrom("bot_events")
      .select(["account_id", "state"])
      .where("state", "in", ["pending", "processing", "failed"])
      .execute();
    const counts = new Map<string, { pending: number; failed: number }>();
    for (const row of rows) {
      const current = counts.get(row.account_id) ?? { pending: 0, failed: 0 };
      if (row.state === "failed") current.failed += 1;
      else current.pending += 1;
      counts.set(row.account_id, current);
    }
    return counts;
  }

  private async outboundCounts(): Promise<Map<string, { pending: number; failed: number }>> {
    const rows = await this.db
      .selectFrom("bot_outbound")
      .select(["account_id", "state"])
      .where("state", "in", ["pending", "sending", "failed"])
      .execute();
    const counts = new Map<string, { pending: number; failed: number }>();
    for (const row of rows) {
      const current = counts.get(row.account_id) ?? { pending: 0, failed: 0 };
      if (row.state === "failed") current.failed += 1;
      else current.pending += 1;
      counts.set(row.account_id, current);
    }
    return counts;
  }
}
