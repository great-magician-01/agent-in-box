import { Inject } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { BotAccountRecord } from "@agent-in-box/protocol";
import type { DurableIngressStore, InboundBotMessage } from "@agent-in-box/bot-connector";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";

const MAX_TEXT = 20_000;
const MAX_RAW_JSON = 512 * 1024;

/** Per-account durable admission store wired into the bot connector pipeline. */
export class BotIngressStore implements DurableIngressStore {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly outbox: OutboxRepository,
    private readonly account: BotAccountRecord,
    private readonly deviceId: string,
  ) {}

  async admit(key: string, message: InboundBotMessage): Promise<boolean> {
    const now = nowIso();
    const text = message.text.slice(0, MAX_TEXT);
    const rawJson = safeJson(message.raw);
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("bot_events")
        .values({
          dedup_key: key,
          account_id: this.account.id,
          platform: this.account.platform,
          event_id: message.eventId,
          platform_user_id: message.platformUserId,
          conversation_id: message.conversationId,
          text,
          received_at: message.receivedAt,
          raw_json: rawJson,
          state: "pending",
          attempts: 0,
          last_error: null,
          next_attempt_at: now,
          created_at: now,
          updated_at: now,
          processed_at: null,
        })
        .onConflict((conflict) => conflict.column("dedup_key").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) {
        return false;
      }
      await trx
        .updateTable("bot_accounts")
        .set({ last_event_at: now, updated_at: now })
        .where("id", "=", this.account.id)
        .execute();
      await this.outbox.append(
        "bot.ingress_received",
        {
          accountId: this.account.id,
          platform: this.account.platform,
          eventId: message.eventId,
          conversationId: message.conversationId,
        },
        now,
        trx,
      );
      return true;
    });
  }
}

export function createBotIngressStore(
  db: Kysely<DatabaseSchema>,
  outbox: OutboxRepository,
  account: BotAccountRecord,
  deviceId: string,
): BotIngressStore {
  return new BotIngressStore(db, outbox, account, deviceId);
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value ?? {});
    if (encoded.length <= MAX_RAW_JSON) return encoded;
    return JSON.stringify({ truncated: true, reason: "raw event exceeded size limit" });
  } catch {
    return "{}";
  }
}
