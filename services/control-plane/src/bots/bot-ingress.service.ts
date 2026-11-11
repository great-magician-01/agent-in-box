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
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { BotCommandService } from "./bot-command.service";

const DEFAULT_MAX_AGE_MS = 30 * 60_000;

export const BOT_INGRESS_OPTIONS = Symbol("AGENT_IN_BOX_BOT_INGRESS_OPTIONS");

export interface BotIngressOptions {
  tickIntervalMs?: number;
  autoTick?: boolean;
  maxEventAgeMs?: number;
  maxAttempts?: number;
  processingTimeoutMs?: number;
  now?: () => Date;
}

interface PendingEventRow {
  dedup_key: string;
  account_id: string;
  platform: string;
  event_id: string;
  platform_user_id: string;
  conversation_id: string;
  text: string;
  received_at: string;
  raw_json: string;
  attempts: number;
}

@Injectable()
export class BotIngressDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotIngressDispatcherService.name);
  private readonly tickIntervalMs: number;
  private readonly autoTick: boolean;
  private readonly maxEventAgeMs: number;
  private readonly maxAttempts: number;
  private readonly processingTimeoutMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly commands: BotCommandService,
    private readonly outbox: OutboxRepository,
    @Optional() @Inject(BOT_INGRESS_OPTIONS) options: BotIngressOptions = {},
  ) {
    const envTick = Number(process.env.AGENT_IN_BOX_BOT_INGRESS_TICK_MS);
    this.tickIntervalMs = Math.max(
      100,
      options.tickIntervalMs ?? (Number.isFinite(envTick) && envTick > 0 ? envTick : 750),
    );
    this.autoTick = options.autoTick ?? true;
    this.maxEventAgeMs = Math.max(60_000, options.maxEventAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.processingTimeoutMs = Math.max(30_000, options.processingTimeoutMs ?? 5 * 60_000);
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

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reclaimStaleProcessing();
      await this.processAvailable(10);
    } catch (error) {
      this.logger.error(
        `Bot ingress dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async processAvailable(limit = 20): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimNext();
      if (!event) break;
      await this.process(event);
      processed += 1;
    }
    return processed;
  }

  private async reclaimStaleProcessing(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.processingTimeoutMs).toISOString();
    await this.db
      .updateTable("bot_events")
      .set({ state: "pending", next_attempt_at: nowIso(), updated_at: nowIso() })
      .where("state", "=", "processing")
      .where("updated_at", "<", cutoff)
      .execute();
  }

  private async claimNext(): Promise<PendingEventRow | null> {
    const now = nowIso();
    const candidate = await this.db
      .selectFrom("bot_events")
      .select([
        "dedup_key",
        "account_id",
        "platform",
        "event_id",
        "platform_user_id",
        "conversation_id",
        "text",
        "received_at",
        "raw_json",
        "attempts",
      ])
      .where("state", "=", "pending")
      .where("next_attempt_at", "<=", now)
      .orderBy("received_at", "asc")
      .orderBy("created_at", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return null;
    const claimed = await this.db
      .updateTable("bot_events")
      .set({ state: "processing", updated_at: now })
      .where("dedup_key", "=", candidate.dedup_key)
      .where("state", "=", "pending")
      .executeTakeFirst();
    return Number(claimed.numUpdatedRows ?? 0) > 0 ? candidate : null;
  }

  private async process(event: PendingEventRow): Promise<void> {
    const account = await this.db
      .selectFrom("bot_accounts")
      .selectAll()
      .where("id", "=", event.account_id)
      .executeTakeFirst();
    if (!account) {
      await this.finishFailed(event, "机器人账号已被删除");
      return;
    }
    try {
      const authenticated = await this.commands.handleInbound({
        accountId: event.account_id,
        platform: event.platform as BotPlatform,
        eventId: event.event_id,
        dedupKey: event.dedup_key,
        platformUserId: event.platform_user_id,
        conversationId: event.conversation_id,
        text: event.text,
        receivedAt: event.received_at,
        raw: parseJson(event.raw_json),
        stale: isStale(event.received_at, this.now(), this.maxEventAgeMs),
      });
      if (!authenticated) {
        await this.finishFailed(event, "机器人事件处理被拒绝");
        return;
      }
      await this.db
        .updateTable("bot_events")
        .set({
          state: "processed",
          processed_at: nowIso(),
          updated_at: nowIso(),
          last_error: null,
        })
        .where("dedup_key", "=", event.dedup_key)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.retryOrFail(event, message);
    }
  }

  private async retryOrFail(event: PendingEventRow, message: string): Promise<void> {
    const attempts = event.attempts + 1;
    const bounded = message.slice(0, 1000);
    if (attempts >= this.maxAttempts) {
      await this.finishFailed(event, bounded, attempts);
      return;
    }
    const nextAttempt = new Date(
      this.now().getTime() + Math.min(60_000, 1000 * 2 ** attempts),
    ).toISOString();
    await this.db
      .updateTable("bot_events")
      .set({
        state: "pending",
        attempts,
        last_error: bounded,
        next_attempt_at: nextAttempt,
        updated_at: nowIso(),
      })
      .where("dedup_key", "=", event.dedup_key)
      .execute();
  }

  private async finishFailed(
    event: PendingEventRow,
    message: string,
    attempts = event.attempts + 1,
  ): Promise<void> {
    const bounded = message.slice(0, 1000);
    await this.db
      .updateTable("bot_events")
      .set({
        state: "failed",
        attempts,
        last_error: bounded,
        updated_at: nowIso(),
        processed_at: nowIso(),
      })
      .where("dedup_key", "=", event.dedup_key)
      .execute();
    await this.outbox.append(
      "bot.ingress_failed",
      {
        accountId: event.account_id,
        platform: event.platform,
        eventId: event.event_id,
        error: bounded,
      },
      nowIso(),
    );
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function isStale(receivedAt: string, now: Date, maxAgeMs: number): boolean {
  const parsed = Date.parse(receivedAt);
  if (!Number.isFinite(parsed)) return true;
  return now.getTime() - parsed > maxAgeMs;
}
