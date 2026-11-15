import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  BotAccountConfig,
  BotAccountCreateRequest,
  BotAccountRecord,
  BotAccountUpdateRequest,
  BotPlatform,
  BotRuntimeState,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { SettingsService } from "../settings/settings.service";
import {
  BOT_ACTIVE_DEVICE_ID_KEY,
  BOT_DEVICE_ID_KEY,
  isBotPlatform,
  toBotAccountRecord,
} from "./bot-support";

const APP_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_NAME_LENGTH = 60;

export interface BotAccountValidation {
  platform: BotPlatform;
  name: string;
  appId: string;
  credentialProviderId: string;
  config: BotAccountConfig;
  enabled: boolean;
}

@Injectable()
export class BotAccountService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxRepository,
  ) {}

  async list(): Promise<BotAccountRecord[]> {
    const rows = await this.db
      .selectFrom("bot_accounts")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toBotAccountRecord);
  }

  async listEnabled(): Promise<BotAccountRecord[]> {
    const rows = await this.db
      .selectFrom("bot_accounts")
      .selectAll()
      .where("enabled", "=", 1)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toBotAccountRecord);
  }

  async get(accountId: string): Promise<BotAccountRecord> {
    const row = await this.db
      .selectFrom("bot_accounts")
      .selectAll()
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", `机器人账号不存在：${accountId}`);
    return toBotAccountRecord(row);
  }

  async create(input: BotAccountCreateRequest): Promise<BotAccountRecord> {
    const validated = this.validateCreate(input);
    await this.assertAppIdAvailable(validated.platform, validated.appId);
    const now = nowIso();
    const id = randomUUID();
    const deviceId = await this.ensureDeviceId();
    const activeDeviceId = await this.activeDeviceId();
    const enabled = validated.enabled && activeDeviceId === deviceId;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("bot_accounts")
        .values({
          id,
          platform: validated.platform,
          name: validated.name,
          enabled: validated.enabled ? 1 : 0,
          app_id: validated.appId,
          credential_provider_id: validated.credentialProviderId,
          config_json: JSON.stringify(validated.config),
          device_id: deviceId,
          state: enabled ? "disconnected" : "disabled",
          last_connected_at: null,
          last_error: null,
          last_event_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await this.outbox.append(
        "bot.account_changed",
        { accountId: id, platform: validated.platform, action: "created" },
        now,
        trx,
      );
    });
    return this.get(id);
  }

  async update(accountId: string, input: BotAccountUpdateRequest): Promise<BotAccountRecord> {
    const existing = await this.get(accountId);
    const name =
      input.name === undefined ? existing.name : normalizeName(input.name, existing.name);
    const appId =
      input.appId === undefined ? existing.appId : normalizeAppId(existing.platform, input.appId);
    if (appId !== existing.appId) {
      await this.assertAppIdAvailable(existing.platform, appId, accountId);
    }
    const credentialProviderId =
      input.credentialProviderId === undefined
        ? existing.credentialProviderId
        : normalizeCredentialProviderId(input.credentialProviderId);
    const config =
      input.config === undefined ? existing.config : normalizeAccountConfig(input.config);
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled === true;
    const deviceId = await this.ensureDeviceId();
    const activeDeviceId = await this.activeDeviceId();
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("bot_accounts")
        .set({
          name,
          app_id: appId,
          credential_provider_id: credentialProviderId,
          config_json: JSON.stringify(config),
          enabled: enabled ? 1 : 0,
          device_id: deviceId,
          state: enabled && activeDeviceId === deviceId ? existing.state : "disabled",
          last_error: enabled && activeDeviceId === deviceId ? existing.lastError : null,
          updated_at: now,
        })
        .where("id", "=", accountId)
        .execute();
      await this.outbox.append(
        "bot.account_changed",
        { accountId, platform: existing.platform, action: "updated" },
        now,
        trx,
      );
    });
    return this.get(accountId);
  }

  async delete(accountId: string): Promise<void> {
    const existing = await this.get(accountId);
    const now = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("bot_accounts").where("id", "=", accountId).execute();
      await this.outbox.append(
        "bot.account_changed",
        { accountId, platform: existing.platform, action: "deleted" },
        now,
        trx,
      );
    });
  }

  async setRuntimeState(
    accountId: string,
    state: BotRuntimeState,
    input: { error?: string | null; connectedAt?: string | null } = {},
  ): Promise<void> {
    const patch: {
      state: string;
      last_error?: string | null;
      last_connected_at?: string | null;
      updated_at: string;
    } = { state, updated_at: nowIso() };
    if (input.error !== undefined) patch.last_error = input.error;
    if (input.connectedAt !== undefined) patch.last_connected_at = input.connectedAt;
    await this.db.updateTable("bot_accounts").set(patch).where("id", "=", accountId).execute();
  }

  async markEvent(accountId: string, at = nowIso()): Promise<void> {
    await this.db
      .updateTable("bot_accounts")
      .set({ last_event_at: at, updated_at: at })
      .where("id", "=", accountId)
      .execute();
  }

  async ensureDeviceId(): Promise<string> {
    const stored = await this.settings.getJson<string>(BOT_DEVICE_ID_KEY);
    if (typeof stored === "string" && stored.trim()) return stored;
    const id = randomUUID();
    await this.settings.setJson(BOT_DEVICE_ID_KEY, id);
    return id;
  }

  async activeDeviceId(): Promise<string | null> {
    const stored = await this.settings.getJson<string | null>(BOT_ACTIVE_DEVICE_ID_KEY);
    return typeof stored === "string" && stored.trim() ? stored : null;
  }

  async setActiveDevice(active: boolean): Promise<void> {
    const deviceId = await this.ensureDeviceId();
    const activeDeviceId = active ? deviceId : null;
    await this.settings.setJson(BOT_ACTIVE_DEVICE_ID_KEY, activeDeviceId);
    const now = nowIso();
    await this.db
      .updateTable("bot_accounts")
      .set({ state: "disabled", last_error: null, updated_at: now })
      .execute();
  }

  deviceName(): string {
    return hostname() || "本机";
  }

  private async assertAppIdAvailable(
    platform: BotPlatform,
    appId: string,
    exceptAccountId?: string,
  ): Promise<void> {
    let query = this.db
      .selectFrom("bot_accounts")
      .select("id")
      .where("platform", "=", platform)
      .where("app_id", "=", appId);
    if (exceptAccountId) query = query.where("id", "!=", exceptAccountId);
    const existing = await query.executeTakeFirst();
    if (existing) {
      throw new PersistenceError("conflict", "该平台 App ID 已配置为其他机器人账号");
    }
  }

  private validateCreate(input: BotAccountCreateRequest): BotAccountValidation {
    if (!isBotPlatform(input?.platform)) {
      throw new PersistenceError("validation_failed", "机器人平台必须是 feishu 或 qq");
    }
    const platform = input.platform;
    const appId = normalizeAppId(platform, input.appId);
    const name = normalizeName(input.name, platform === "feishu" ? "飞书机器人" : "QQ 机器人");
    const credentialProviderId =
      input.credentialProviderId === undefined || !String(input.credentialProviderId).trim()
        ? defaultCredentialProviderId(platform, appId)
        : normalizeCredentialProviderId(input.credentialProviderId);
    const config = normalizeAccountConfig(input.config ?? {});
    if (typeof input.secret === "string" && input.secret.length > 0) {
      if (input.secret.length < 8 || input.secret.length > 16_384) {
        throw new PersistenceError("validation_failed", "机器人 Secret 长度无效");
      }
    }
    return {
      platform,
      name,
      appId,
      credentialProviderId,
      config,
      enabled: input.enabled === true,
    };
  }
}

function normalizeName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") {
    throw new PersistenceError("validation_failed", "机器人名称必须是字符串");
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_NAME_LENGTH) {
    throw new PersistenceError(
      "validation_failed",
      `机器人名称长度必须在 1 到 ${MAX_NAME_LENGTH} 个字符之间`,
    );
  }
  return value;
}

function normalizeAppId(platform: BotPlatform, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PersistenceError("validation_failed", "机器人 App ID 不能为空");
  }
  const value = raw.trim();
  if (platform === "feishu" && !FEISHU_APP_ID_PATTERN.test(value)) {
    throw new PersistenceError("validation_failed", "飞书 App ID 必须为 cli_ 加 16 位十六进制字符");
  }
  if (!APP_ID_PATTERN.test(value)) {
    throw new PersistenceError("validation_failed", "机器人 App ID 格式无效");
  }
  return value;
}

function normalizeCredentialProviderId(raw: unknown): string {
  if (typeof raw !== "string" || !CREDENTIAL_ID_PATTERN.test(raw.trim())) {
    throw new PersistenceError(
      "validation_failed",
      "凭据标识必须以小写字母或数字开头，且不超过 40 个字符",
    );
  }
  const value = raw.trim();
  if (!value.startsWith("bot-")) {
    throw new PersistenceError(
      "validation_failed",
      "机器人凭据标识必须以 bot- 开头，以便与模型凭据隔离",
    );
  }
  return value;
}

function defaultCredentialProviderId(platform: BotPlatform, appId: string): string {
  const suffix = appId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  return `bot-${platform}-${suffix}`.slice(0, 40);
}

function normalizeAccountConfig(input: BotAccountConfig): BotAccountConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PersistenceError("validation_failed", "机器人配置必须是对象");
  }
  const config: BotAccountConfig = {};
  for (const key of ["domain", "apiBase", "tokenBaseUrl"] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") {
      throw new PersistenceError("validation_failed", `机器人配置 ${key} 必须是 URL`);
    }
    const value = raw.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PersistenceError("validation_failed", `机器人配置 ${key} 不是有效 URL`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new PersistenceError(
        "validation_failed",
        `机器人配置 ${key} 必须使用 HTTPS（本机测试可使用回环 HTTP）`,
      );
    }
    if (url.username || url.password) {
      throw new PersistenceError("validation_failed", `机器人配置 ${key} 不能包含凭据`);
    }
    config[key] = value.replace(/\/$/, "");
  }
  if (input.botUserId !== undefined && input.botUserId !== null && input.botUserId !== "") {
    if (typeof input.botUserId !== "string" || input.botUserId.length > 128) {
      throw new PersistenceError("validation_failed", "机器人 Open ID 格式无效");
    }
    config.botUserId = input.botUserId.trim();
  }
  if (input.intents !== undefined && input.intents !== null) {
    if (
      typeof input.intents !== "number" ||
      !Number.isInteger(input.intents) ||
      input.intents < 0 ||
      input.intents > 2 ** 31 - 1
    ) {
      throw new PersistenceError("validation_failed", "QQ Intents 必须是 32 位非负整数");
    }
    config.intents = input.intents;
  }
  return config;
}
