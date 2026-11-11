import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { BotPlatform } from "@agent-in-box/protocol";
import type { OutboundBotMessage } from "@agent-in-box/bot-connector";
import { safeErrorMessage } from "@agent-in-box/bot-connector";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { BotConnectorService } from "./bot-connector.service";
import { splitBotText } from "./bot-support";

const MAX_ATTEMPTS = 5;
const MAX_TEXT = 20_000;

export const BOT_OUTBOUND_OPTIONS = Symbol("AGENT_IN_BOX_BOT_OUTBOUND_OPTIONS");

export interface BotOutboundOptions {
  tickIntervalMs?: number;
  autoTick?: boolean;
  now?: () => Date;
}

export interface EnqueueOutboundInput {
  accountId: string;
  platform: BotPlatform;
  conversationId: string;
  text: string;
  kind: string;
  refId?: string | null;
  dedupeKey: string;
  replyToMessageId?: string | null;
}

@Injectable()
export class BotOutboundService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotOutboundService.name);
  private readonly tickIntervalMs: number;
  private readonly autoTick: boolean;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly connectors: BotConnectorService,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(BOT_OUTBOUND_OPTIONS) options: BotOutboundOptions = {},
  ) {
    const envTick = Number(process.env.AGENT_IN_BOX_BOT_OUTBOUND_TICK_MS);
    this.tickIntervalMs = Math.max(
      100,
      options.tickIntervalMs ?? (Number.isFinite(envTick) && envTick > 0 ? envTick : 500),
    );
    this.autoTick = options.autoTick ?? true;
    this.now = options.now ?? (() => new Date());
  }

  onModuleInit(): void {
    if (!this.autoTick) return;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(input: EnqueueOutboundInput): Promise<number> {
    // QQ text messages have a tighter byte budget than Feishu; use a smaller
    // character cap so multi-byte Chinese text does not get rejected.
    const chunks = splitBotText(input.text, input.platform === "qq" ? 1500 : undefined);
    if (chunks.length === 0) return 0;
    let queued = 0;
    const now = this.now().toISOString();
    for (const [index, chunk] of chunks.entries()) {
      const dedupeKey = chunks.length === 1 ? input.dedupeKey : `${input.dedupeKey}:part:${index}`;
      const id = `${now}-${String(index).padStart(3, "0")}-${randomUUID()}`;
      const inserted = await this.db
        .insertInto("bot_outbound")
        .values({
          id,
          account_id: input.accountId,
          platform: input.platform,
          conversation_id: input.conversationId,
          text: chunk.slice(0, MAX_TEXT),
          kind: input.kind,
          ref_id: input.refId ?? null,
          dedupe_key: dedupeKey,
          reply_to_message_id: input.replyToMessageId ?? null,
          state: "pending",
          attempts: 0,
          next_attempt_at: now,
          last_error: null,
          created_at: now,
          sent_at: null,
        })
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) queued += 1;
    }
    return queued;
  }

  async sendTest(accountId: string, conversationId: string, text: string): Promise<number> {
    const trimmedConversation = conversationId.trim();
    const trimmedText = text.trim();
    if (!trimmedConversation || trimmedConversation.length > 256) {
      throw new PersistenceError("validation_failed", "测试消息会话 ID 无效");
    }
    if (!trimmedText || trimmedText.length > MAX_TEXT) {
      throw new PersistenceError("validation_failed", `测试消息必须为 1～${MAX_TEXT} 个字符`);
    }
    const account = await this.db
      .selectFrom("bot_accounts")
      .select(["id", "platform"])
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (!account) throw new PersistenceError("not_found", `机器人账号不存在：${accountId}`);
    return this.enqueue({
      accountId,
      platform: account.platform as BotPlatform,
      conversationId: trimmedConversation,
      text: trimmedText,
      kind: "test",
      dedupeKey: `test:${accountId}:${randomUUID()}`,
    });
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const rows = await this.db
        .selectFrom("bot_outbound")
        .selectAll()
        .where("state", "=", "pending")
        .where("next_attempt_at", "<=", this.now().toISOString())
        .orderBy("id", "asc")
        .limit(25)
        .execute();
      for (const row of rows) {
        await this.deliver(row);
      }
    } catch (error) {
      this.logger.error(
        `Bot outbound dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async flush(limit = 50): Promise<number> {
    let sent = 0;
    for (let index = 0; index < limit; index += 1) {
      const row = await this.db
        .selectFrom("bot_outbound")
        .selectAll()
        .where("state", "=", "pending")
        .where("next_attempt_at", "<=", this.now().toISOString())
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst();
      if (!row) break;
      if (await this.deliver(row)) sent += 1;
    }
    return sent;
  }

  private async deliver(row: {
    id: string;
    account_id: string;
    platform: string;
    conversation_id: string;
    text: string;
    kind: string;
    attempts: number;
    reply_to_message_id: string | null;
  }): Promise<boolean> {
    const connector = this.connectors.getConnected(row.account_id);
    if (!connector) {
      await this.reschedule(row, "机器人连接尚未就绪", false);
      return false;
    }
    try {
      const message: OutboundBotMessage & {
        replyToMessageId?: string;
      } = {
        platform: row.platform as BotPlatform,
        conversationId: row.conversation_id,
        text: row.text,
      };
      if (row.platform === "qq" && row.reply_to_message_id) {
        message.replyToMessageId = row.reply_to_message_id;
      }
      await connector.send(message);
      const now = nowIso();
      await this.db
        .updateTable("bot_outbound")
        .set({ state: "sent", sent_at: now })
        .where("id", "=", row.id)
        .execute();
      await this.outbox.append(
        "bot.message_sent",
        {
          accountId: row.account_id,
          platform: row.platform,
          conversationId: row.conversation_id,
        },
        now,
      );
      return true;
    } catch (error) {
      await this.reschedule(row, safeErrorMessage(error), true);
      return false;
    }
  }

  private async reschedule(
    row: { id: string; attempts: number },
    error: string,
    countFailure: boolean,
  ): Promise<void> {
    const attempts = countFailure ? row.attempts + 1 : row.attempts;
    const failed = countFailure && attempts >= MAX_ATTEMPTS;
    const nextAttempt = new Date(
      this.now().getTime() + (countFailure ? Math.min(60_000, 1000 * 2 ** attempts) : 3000),
    ).toISOString();
    await this.db
      .updateTable("bot_outbound")
      .set({
        state: failed ? "failed" : "pending",
        attempts,
        last_error: error.slice(0, 1000),
        next_attempt_at: nextAttempt,
      })
      .where("id", "=", row.id)
      .execute();
    if (failed) {
      this.logger.warn(
        `Bot outbound message ${row.id} failed after ${attempts} attempts: ${error}`,
      );
    }
  }
}
