import { Inject } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { BotAccountRecord } from "@agent-in-box/protocol";
import type { DurableIngressStore, InboundBotMessage } from "@agent-in-box/bot-connector";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";

const MAX_TEXT = 20_000;
const MAX_RAW_JSON = 512 * 1024;
/** Admission caps keep a chatty or hostile bot from filling the database. */
const MAX_PENDING_EVENTS = 500;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
/** Terminal events are diagnostics; they do not need unlimited retention. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
      // Admission control runs in the same transaction as the insert so a burst
      // of deliveries cannot all pass a stale count.
      const pending = await trx
        .selectFrom("bot_events")
        .select((expression) => [
          expression.fn.count<number>("dedup_key").as("events"),
          expression.fn.sum<number>(sql`length(raw_json)`).as("bytes"),
        ])
        .where("account_id", "=", this.account.id)
        .where("state", "in", ["pending", "processing"])
        .executeTakeFirst();
      const pendingEvents = Number(pending?.events ?? 0);
      const pendingBytes = Number(pending?.bytes ?? 0);
      if (
        pendingEvents >= MAX_PENDING_EVENTS ||
        pendingBytes + rawJson.length > MAX_PENDING_BYTES
      ) {
        return false;
      }
      // Drop terminal diagnostics older than the retention window. The dedup
      // key is still preserved for recent events, so replays stay idempotent.
      await trx
        .deleteFrom("bot_events")
        .where("account_id", "=", this.account.id)
        .where("state", "in", ["processed", "failed"])
        .where("updated_at", "<", new Date(Date.now() - TERMINAL_RETENTION_MS).toISOString())
        .execute();
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
