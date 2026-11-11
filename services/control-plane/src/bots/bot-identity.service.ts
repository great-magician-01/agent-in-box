import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  BotAccessCodeRequest,
  BotAccessCodeView,
  BotChatKind,
  BotChatRecord,
  BotChatUpsertRequest,
  BotIdentityRecord,
  BotIdentityUpsertRequest,
  BotPlatform,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import {
  asIdentityRole,
  createAccessCode,
  hashAccessCode,
  toBotChatRecord,
  toBotIdentityRecord,
} from "./bot-support";

const DEFAULT_CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_TTL_MS = 60 * 60_000;
const MAX_DISPLAY_NAME = 80;
const LOCAL_ADMIN_ID = "local-admin";

export interface BotAuthorization {
  identity: BotIdentityRecord;
  chat: BotChatRecord;
  allowed: boolean;
  reason: string | null;
}

@Injectable()
export class BotIdentityService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly outbox: OutboxRepository,
  ) {}

  async listIdentities(): Promise<BotIdentityRecord[]> {
    const rows = await this.db
      .selectFrom("bot_identities")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toBotIdentityRecord);
  }

  async listChats(): Promise<BotChatRecord[]> {
    const rows = await this.db
      .selectFrom("bot_chats")
      .selectAll()
      .orderBy("last_seen_at", "desc")
      .limit(200)
      .execute();
    return rows.map(toBotChatRecord);
  }

  async findIdentity(
    platform: BotPlatform,
    platformUserId: string,
  ): Promise<BotIdentityRecord | null> {
    const row = await this.db
      .selectFrom("bot_identities")
      .selectAll()
      .where("platform", "=", platform)
      .where("platform_user_id", "=", platformUserId)
      .executeTakeFirst();
    return row ? toBotIdentityRecord(row) : null;
  }

  async upsertIdentity(
    platform: BotPlatform,
    input: BotIdentityUpsertRequest,
  ): Promise<BotIdentityRecord> {
    const platformUserId = normalizePlatformUserId(input?.platformUserId);
    const existing = await this.findIdentity(platform, platformUserId);
    const now = nowIso();
    const role =
      input.role === undefined ? (existing?.role ?? "member") : asIdentityRole(input.role);
    const bound = input.bound === undefined ? (existing?.bound ?? true) : input.bound === true;
    const displayName =
      input.displayName === undefined
        ? (existing?.displayName ?? "")
        : normalizeDisplayName(input.displayName);
    const localUserId = bound ? await this.localUserId() : null;
    const id = existing?.id ?? randomUUID();
    await this.db.transaction().execute(async (trx) => {
      if (existing) {
        await trx
          .updateTable("bot_identities")
          .set({
            display_name: displayName,
            role,
            bound: bound ? 1 : 0,
            local_user_id: localUserId,
            last_seen_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await trx
          .insertInto("bot_identities")
          .values({
            id,
            platform,
            platform_user_id: platformUserId,
            display_name: displayName,
            role,
            bound: bound ? 1 : 0,
            local_user_id: localUserId,
            created_at: now,
            last_seen_at: now,
          })
          .execute();
      }
      if (bound) {
        await this.outbox.append(
          "bot.identity_bound",
          { platform, platformUserId, role },
          now,
          trx,
        );
      }
    });
    return (await this.findIdentity(platform, platformUserId))!;
  }

  async deleteIdentity(platform: BotPlatform, platformUserId: string): Promise<void> {
    await this.db
      .deleteFrom("bot_identities")
      .where("platform", "=", platform)
      .where("platform_user_id", "=", platformUserId)
      .execute();
  }

  async upsertChat(input: BotChatUpsertRequest): Promise<BotChatRecord> {
    const conversationId = normalizeConversationId(input?.conversationId);
    const kind: BotChatKind = input.kind === "group" ? "group" : "p2p";
    const existing = await this.db
      .selectFrom("bot_chats")
      .selectAll()
      .where("platform", "=", input.platform)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    const now = nowIso();
    if (existing) {
      await this.db
        .updateTable("bot_chats")
        .set({
          kind,
          title: input.title === undefined ? existing.title : normalizeTitle(input.title),
          allowed: input.allowed === undefined ? existing.allowed : input.allowed ? 1 : 0,
          project_id: input.projectId === undefined ? existing.project_id : input.projectId,
          last_seen_at: now,
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await this.db
        .insertInto("bot_chats")
        .values({
          id: randomUUID(),
          platform: input.platform,
          conversation_id: conversationId,
          kind,
          title: normalizeTitle(input.title ?? ""),
          allowed: input.allowed === true ? 1 : 0,
          project_id: input.projectId ?? null,
          last_message_id: null,
          created_at: now,
          last_seen_at: now,
        })
        .execute();
    }
    const row = await this.db
      .selectFrom("bot_chats")
      .selectAll()
      .where("platform", "=", input.platform)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return toBotChatRecord(row!);
  }

  async deleteChat(platform: BotPlatform, conversationId: string): Promise<void> {
    await this.db
      .deleteFrom("bot_chats")
      .where("platform", "=", platform)
      .where("conversation_id", "=", conversationId)
      .execute();
  }

  /**
   * Records the inbound chat and returns the current authorization. P2P chats
   * are authorized by a bound identity; group chats additionally require an
   * explicit allowlist row created from the local admin UI.
   */
  async authorizeInbound(input: {
    platform: BotPlatform;
    platformUserId: string;
    conversationId: string;
    kind: BotChatKind;
    title?: string;
    lastMessageId?: string | null;
  }): Promise<BotAuthorization> {
    const now = nowIso();
    const identity = await this.findIdentity(input.platform, input.platformUserId);
    if (identity) {
      await this.db
        .updateTable("bot_identities")
        .set({ last_seen_at: now })
        .where("id", "=", identity.id)
        .execute();
    }
    let row = await this.db
      .selectFrom("bot_chats")
      .selectAll()
      .where("platform", "=", input.platform)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    if (!row) {
      const id = randomUUID();
      await this.db
        .insertInto("bot_chats")
        .values({
          id,
          platform: input.platform,
          conversation_id: input.conversationId,
          kind: input.kind,
          title: normalizeTitle(input.title ?? ""),
          allowed: input.kind === "p2p" && identity?.bound === true ? 1 : 0,
          project_id: null,
          last_message_id: input.lastMessageId ?? null,
          created_at: now,
          last_seen_at: now,
        })
        .execute();
      row = await this.db
        .selectFrom("bot_chats")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    } else {
      await this.db
        .updateTable("bot_chats")
        .set({
          kind: input.kind,
          ...(input.kind === "p2p" && identity?.bound === true ? { allowed: 1 } : {}),
          ...(input.title ? { title: normalizeTitle(input.title) } : {}),
          ...(input.lastMessageId !== undefined ? { last_message_id: input.lastMessageId } : {}),
          last_seen_at: now,
        })
        .where("id", "=", row.id)
        .execute();
      row = await this.db
        .selectFrom("bot_chats")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirst();
    }
    const chat = toBotChatRecord(row!);
    if (!identity || !identity.bound) {
      return {
        identity: identity ?? emptyIdentity(input),
        chat,
        allowed: false,
        reason: "unbound",
      };
    }
    if (input.kind === "group" && !chat.allowed) {
      return { identity, chat, allowed: false, reason: "chat_not_allowed" };
    }
    return { identity, chat, allowed: true, reason: null };
  }

  async createAccessCode(input: BotAccessCodeRequest = {}): Promise<BotAccessCodeView> {
    const role = asIdentityRole(input.role ?? "admin");
    const expiresInMs = Math.min(
      MAX_CODE_TTL_MS,
      Math.max(60_000, input.expiresInMs ?? DEFAULT_CODE_TTL_MS),
    );
    const code = createAccessCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMs).toISOString();
    await this.db
      .insertInto("bot_access_codes")
      .values({
        id: randomUUID(),
        code_hash: hashAccessCode(code),
        role,
        expires_at: expiresAt,
        created_at: now.toISOString(),
        used_at: null,
        used_by: null,
      })
      .execute();
    return { code, role, expiresAt };
  }

  async bindWithCode(input: {
    platform: BotPlatform;
    platformUserId: string;
    displayName?: string;
    code: string;
  }): Promise<BotIdentityRecord> {
    const code = input.code.trim().toUpperCase();
    if (!code) throw new PersistenceError("validation_failed", "绑定码不能为空");
    const now = nowIso();
    const row = await this.db
      .selectFrom("bot_access_codes")
      .selectAll()
      .where("code_hash", "=", hashAccessCode(code))
      .executeTakeFirst();
    if (!row || row.used_at !== null) {
      throw new PersistenceError("validation_failed", "绑定码无效或已使用");
    }
    if (row.expires_at <= now) {
      throw new PersistenceError("validation_failed", "绑定码已过期");
    }
    const used = await this.db
      .updateTable("bot_access_codes")
      .set({ used_at: now, used_by: `${input.platform}:${input.platformUserId}` })
      .where("id", "=", row.id)
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(used.numUpdatedRows ?? 0) === 0) {
      throw new PersistenceError("validation_failed", "绑定码已被使用");
    }
    return this.upsertIdentity(input.platform, {
      platformUserId: input.platformUserId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      role: asIdentityRole(row.role),
      bound: true,
    });
  }

  private async localUserId(): Promise<string | null> {
    const row = await this.db
      .selectFrom("local_users")
      .select("id")
      .where("id", "=", LOCAL_ADMIN_ID)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}

function normalizePlatformUserId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 128) {
    throw new PersistenceError("validation_failed", "平台用户 ID 无效");
  }
  return raw.trim();
}

function normalizeConversationId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 256) {
    throw new PersistenceError("validation_failed", "平台会话 ID 无效");
  }
  return raw.trim();
}

function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PersistenceError("validation_failed", "显示名称必须是字符串");
  }
  const value = raw.trim();
  if (value.length > MAX_DISPLAY_NAME) {
    throw new PersistenceError("validation_failed", "显示名称过长");
  }
  return value;
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 200);
}

function emptyIdentity(input: {
  platform: BotPlatform;
  platformUserId: string;
}): BotIdentityRecord {
  return {
    id: "",
    platform: input.platform,
    platformUserId: input.platformUserId,
    displayName: "",
    role: "member",
    bound: false,
    createdAt: "",
    lastSeenAt: "",
  };
}
