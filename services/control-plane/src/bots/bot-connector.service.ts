import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { BotAccountRecord, BotRuntimeState } from "@agent-in-box/protocol";
import {
  createFeishuBotConnector,
  createQqBotConnector,
  redactSecrets,
  safeErrorMessage,
  type BotConnector,
  type BotConnectorLogger,
  type DurableIngressStore,
} from "@agent-in-box/bot-connector";
import type { ModelCredentialProvider } from "../models/credential-provider";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { assertSafeOutboundUrl } from "../security/outbound";
import { BotAccountService } from "./bot-account.service";
import { createBotIngressStore } from "./bot-ingress-store";

export const BOT_CREDENTIAL_PROVIDER = Symbol("AGENT_IN_BOX_BOT_CREDENTIAL_PROVIDER");
export const BOT_CONNECTOR_OPTIONS = Symbol("AGENT_IN_BOX_BOT_CONNECTOR_OPTIONS");

export interface BotConnectorFactoryInput {
  account: BotAccountRecord;
  secret: string;
  deviceId: string;
  ingressStore: DurableIngressStore;
  logger: BotConnectorLogger;
}

export type BotConnectorFactory = (input: BotConnectorFactoryInput) => BotConnector;

export interface BotConnectorOptions {
  tickIntervalMs?: number;
  autoTick?: boolean;
  connectTimeoutMs?: number;
  retryBaseMs?: number;
  now?: () => Date;
  connectorFactory?: BotConnectorFactory;
}

interface RunningConnector {
  accountId: string;
  platform: string;
  fingerprint: string;
  connector: BotConnector;
  state: BotRuntimeState;
  retryAt: number;
  retryCount: number;
}

@Injectable()
export class BotConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotConnectorService.name);
  private readonly tickIntervalMs: number;
  private readonly autoTick: boolean;
  private readonly connectTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly connectorFactory: BotConnectorFactory;
  private readonly running = new Map<string, RunningConnector>();
  private readonly retryAfter = new Map<string, { at: number; count: number }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly accounts: BotAccountService,
    private readonly outbox: OutboxRepository,
    @Inject(BOT_CREDENTIAL_PROVIDER) private readonly credentials: ModelCredentialProvider,
    @Optional() @Inject(BOT_CONNECTOR_OPTIONS) options: BotConnectorOptions = {},
  ) {
    const envTick = Number(process.env.AGENT_IN_BOX_BOT_TICK_MS);
    this.tickIntervalMs = Math.max(
      250,
      options.tickIntervalMs ?? (Number.isFinite(envTick) && envTick > 0 ? envTick : 2000),
    );
    this.autoTick = options.autoTick ?? true;
    this.connectTimeoutMs = Math.max(1000, options.connectTimeoutMs ?? 15_000);
    this.retryBaseMs = Math.max(1000, options.retryBaseMs ?? 5000);
    this.now = options.now ?? (() => new Date());
    this.connectorFactory = options.connectorFactory ?? defaultConnectorFactory;
  }

  onModuleInit(): void {
    if (!this.autoTick) return;
    setTimeout(() => void this.tick(), 0).unref();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const entries = [...this.running.values()];
    this.running.clear();
    await Promise.all(entries.map((item) => item.connector.disconnect().catch(() => undefined)));
  }

  getConnected(accountId: string): BotConnector | null {
    const item = this.running.get(accountId);
    if (!item) return null;
    return item.connector.getStatus().state === "connected" ? item.connector : null;
  }

  getConnector(accountId: string): BotConnector | null {
    return this.running.get(accountId)?.connector ?? null;
  }

  runningState(accountId: string): BotRuntimeState | null {
    return this.running.get(accountId)?.state ?? null;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const deviceId = await this.accounts.ensureDeviceId();
      const activeDeviceId = await this.accounts.activeDeviceId();
      const active = activeDeviceId === deviceId;
      const enabled = await this.accounts.listEnabled();
      const enabledIds = new Set(enabled.map((account) => account.id));

      for (const [accountId, item] of this.running) {
        if (!active || !enabledIds.has(accountId)) {
          await this.stopRunning(accountId, item, "机器人已停用或本机不再是活跃设备");
          if (!enabledIds.has(accountId)) {
            await this.accounts.setRuntimeState(accountId, "disabled", { error: null });
          }
        }
      }

      if (!active) {
        const all = await this.accounts.list();
        for (const account of all) {
          if (account.state !== "disabled") {
            await this.accounts.setRuntimeState(account.id, "disabled", { error: null });
          }
        }
        return;
      }

      for (const account of enabled) {
        const item = this.running.get(account.id);
        const fingerprint = accountFingerprint(account);
        if (item && item.fingerprint !== fingerprint) {
          await this.stopRunning(account.id, item, "机器人配置已更新");
        }
        const current = this.running.get(account.id);
        if (current) {
          await this.refreshState(account, current);
          continue;
        }
        const retry = this.retryAfter.get(account.id);
        if (retry && retry.at > this.now().getTime()) continue;
        await this.startAccount(account, deviceId);
      }
    } catch (error) {
      this.logger.error(
        `Bot connector sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async reconnect(accountId: string): Promise<void> {
    const account = await this.accounts.get(accountId);
    const existing = this.running.get(accountId);
    if (existing) await this.stopRunning(accountId, existing, "手动重连");
    this.retryAfter.delete(accountId);
    const deviceId = await this.accounts.ensureDeviceId();
    const activeDeviceId = await this.accounts.activeDeviceId();
    if (activeDeviceId !== deviceId) {
      throw new PersistenceError("conflict", "本机不是活跃执行电脑，无法连接机器人");
    }
    await this.startAccount(account, deviceId);
  }

  async disconnect(accountId: string): Promise<void> {
    const existing = this.running.get(accountId);
    if (existing) await this.stopRunning(accountId, existing, "手动断开");
    this.retryAfter.delete(accountId);
    await this.accounts.setRuntimeState(accountId, "disconnected", { error: null });
  }

  /**
   * Builds a short-lived connector and waits for its first successful connection.
   * If the real account is already connected this returns its status. The probe
   * reuses the account's device-scoped durable ingress store, so an event that
   * happens to arrive during the check is persisted instead of lost.
   */
  async testAccount(
    account: BotAccountRecord,
    secretOverride?: string,
  ): Promise<{ ok: boolean; state: BotRuntimeState; lastError: string | null }> {
    const existing = this.running.get(account.id);
    if (existing && !secretOverride?.trim()) {
      const status = existing.connector.getStatus();
      return {
        ok: status.state === "connected",
        state: normalizeRuntimeState(status.state),
        lastError: status.lastError,
      };
    }
    let secret = secretOverride?.trim() ?? "";
    if (!secret) {
      secret = await this.credentials.getSecret(account.credentialProviderId);
    }
    if (!secret) {
      throw new PersistenceError("validation_failed", "机器人 Secret 不能为空");
    }
    try {
      await this.assertAccountEndpoints(account);
    } catch (error) {
      return { ok: false, state: "disconnected", lastError: safeErrorMessage(error) };
    }
    const deviceId = await this.accounts.ensureDeviceId();
    const testConnector = this.connectorFactory({
      account,
      secret,
      deviceId,
      ingressStore: createBotIngressStore(this.db, this.outbox, account, deviceId),
      logger: this.botLogger(),
    });
    try {
      await withTimeout(testConnector.connect(), this.connectTimeoutMs, "机器人连接测试超时");
      const status = testConnector.getStatus();
      return {
        ok: status.state === "connected",
        state: status.state,
        lastError: status.lastError,
      };
    } catch (error) {
      return {
        ok: false,
        state: "disconnected",
        lastError: safeErrorMessage(error),
      };
    } finally {
      await testConnector.disconnect().catch(() => undefined);
    }
  }

  private async assertAccountEndpoints(account: BotAccountRecord): Promise<void> {
    for (const raw of [
      account.config.domain,
      account.config.apiBase,
      account.config.tokenBaseUrl,
    ]) {
      if (typeof raw === "string" && raw.trim()) {
        await assertSafeOutboundUrl(raw.trim(), { allowLoopback: true });
      }
    }
  }

  private async startAccount(account: BotAccountRecord, deviceId: string): Promise<void> {
    if (account.deviceId && account.deviceId !== deviceId) {
      await this.accounts.setRuntimeState(account.id, "disabled", {
        error: "机器人绑定的执行电脑不是本机",
      });
      return;
    }
    let secret: string;
    try {
      secret = await this.credentials.getSecret(account.credentialProviderId);
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.accounts.setRuntimeState(account.id, "degraded", { error: message });
      this.scheduleRetry(account.id);
      return;
    }
    try {
      await this.assertAccountEndpoints(account);
    } catch (error) {
      await this.accounts.setRuntimeState(account.id, "degraded", {
        error: safeErrorMessage(error),
      });
      return;
    }
    const ingressStore = createBotIngressStore(this.db, this.outbox, account, deviceId);
    let connector: BotConnector;
    try {
      connector = this.connectorFactory({
        account,
        secret,
        deviceId,
        ingressStore,
        logger: this.botLogger(),
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.accounts.setRuntimeState(account.id, "degraded", { error: message });
      this.scheduleRetry(account.id);
      return;
    }
    const item: RunningConnector = {
      accountId: account.id,
      platform: account.platform,
      fingerprint: accountFingerprint(account),
      connector,
      state: "connecting",
      retryAt: 0,
      retryCount: this.retryAfter.get(account.id)?.count ?? 0,
    };
    this.running.set(account.id, item);
    await this.accounts.setRuntimeState(account.id, "connecting", {
      error: null,
      connectedAt: account.lastConnectedAt,
    });
    void withTimeout(
      connector.connect(),
      Math.max(60_000, this.connectTimeoutMs * 2),
      "机器人首次连接超时",
    )
      .then(async () => {
        if (this.running.get(account.id) !== item) return;
        item.state = "connected";
        item.retryCount = 0;
        this.retryAfter.delete(account.id);
        await this.accounts.setRuntimeState(account.id, "connected", {
          error: null,
          connectedAt: andNow(connector.getStatus().lastConnectedAt, this.now),
        });
        await this.outbox.append("bot.connected", { platform: account.platform }, nowIso());
      })
      .catch(async (error: unknown) => {
        if (this.running.get(account.id) !== item) return;
        item.state = "degraded";
        const message = safeErrorMessage(error);
        await this.accounts.setRuntimeState(account.id, "degraded", { error: message });
        await connector.disconnect().catch(() => undefined);
        this.running.delete(account.id);
        this.scheduleRetry(account.id);
      });
  }

  private async refreshState(account: BotAccountRecord, item: RunningConnector): Promise<void> {
    consumeIngressMemoryQueue(item.connector);
    const status = item.connector.getStatus();
    const state = normalizeRuntimeState(status.state);
    if (state === item.state) {
      if (status.lastError && state !== "connected") {
        await this.accounts.setRuntimeState(account.id, state, { error: status.lastError });
      }
      return;
    }
    const previous = item.state;
    item.state = state;
    if (state === "connected") {
      item.retryCount = 0;
      this.retryAfter.delete(account.id);
      await this.accounts.setRuntimeState(account.id, "connected", {
        error: null,
        connectedAt: andNow(status.lastConnectedAt, this.now),
      });
      await this.outbox.append("bot.connected", { platform: account.platform }, nowIso());
      return;
    }
    await this.accounts.setRuntimeState(account.id, state, { error: status.lastError });
    if ((previous === "connected" || previous === "degraded") && state !== "connecting") {
      await this.outbox.append(
        "bot.disconnected",
        { platform: account.platform, reason: status.lastError ?? state },
        nowIso(),
      );
    }
    if (state === "disconnected") {
      // The connector exhausted its own reconnect budget. Drop it and let the
      // supervisor tick dial again with backoff.
      this.running.delete(account.id);
      await item.connector.disconnect().catch(() => undefined);
      this.scheduleRetry(account.id);
    }
  }

  private async stopRunning(
    accountId: string,
    item: RunningConnector,
    reason: string,
  ): Promise<void> {
    this.running.delete(accountId);
    await item.connector.disconnect().catch(() => undefined);
    if (item.platform === "feishu" || item.platform === "qq") {
      await this.outbox
        .append("bot.disconnected", { platform: item.platform, reason }, nowIso())
        .catch(() => undefined);
    }
    await this.accounts
      .setRuntimeState(accountId, "disconnected", { error: null })
      .catch(() => undefined);
  }

  private scheduleRetry(accountId: string): void {
    const current = this.retryAfter.get(accountId);
    const count = Math.min(6, (current?.count ?? 0) + 1);
    const delay = Math.min(5 * 60_000, this.retryBaseMs * 2 ** (count - 1));
    this.retryAfter.set(accountId, { at: this.now().getTime() + delay, count });
  }

  private botLogger(): BotConnectorLogger {
    const write = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      fields?: Readonly<Record<string, unknown>>,
    ): void => {
      const suffix = fields ? ` ${redactSecrets(JSON.stringify(fields)).slice(0, 1000)}` : "";
      const text = `${redactSecrets(message)}${suffix}`;
      if (level === "info") this.logger.log(text);
      else this.logger[level](text);
    };
    return {
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
    };
  }
}

function defaultConnectorFactory(input: BotConnectorFactoryInput): BotConnector {
  if (input.account.platform === "feishu") {
    return createFeishuBotConnector({
      appId: input.account.appId,
      appSecret: input.secret,
      deviceId: input.deviceId,
      ...(input.account.config.domain ? { domain: input.account.config.domain } : {}),
      ingressStore: input.ingressStore,
      autoDispatchIngress: false,
      logger: input.logger,
    });
  }
  return createQqBotConnector({
    appId: input.account.appId,
    clientSecret: input.secret,
    deviceId: input.deviceId,
    ...(input.account.config.apiBase ? { apiBase: input.account.config.apiBase } : {}),
    ...(input.account.config.tokenBaseUrl
      ? { tokenBaseUrl: input.account.config.tokenBaseUrl }
      : {}),
    ...(input.account.config.intents !== undefined
      ? { intents: input.account.config.intents }
      : {}),
    ingressStore: input.ingressStore,
    autoDispatchIngress: false,
    logger: input.logger,
  });
}

function accountFingerprint(account: BotAccountRecord): string {
  return JSON.stringify({
    platform: account.platform,
    appId: account.appId,
    credentialProviderId: account.credentialProviderId,
    config: account.config,
    deviceId: account.deviceId,
    enabled: account.enabled,
  });
}

function normalizeRuntimeState(state: string): BotRuntimeState {
  return ["connecting", "connected", "degraded", "disconnected"].includes(state)
    ? (state as BotRuntimeState)
    : "disconnected";
}

function consumeIngressMemoryQueue(connector: BotConnector): void {
  // Ingress is already durable. Clear the connector's in-memory copy so it
  // cannot grow unbounded when autoDispatchIngress is disabled.
  connector.drainIngress?.();
}

function andNow(value: string | null, now: () => Date): string {
  return value ?? now().toISOString();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
