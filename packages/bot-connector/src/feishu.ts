/**
 * Feishu (Lark) connector built on the official `@larksuiteoapi/node-sdk`
 * WSClient. The official SDK owns the raw protobuf framing, long-connection
 * bootstrap, ping/pong, ACK and reconnect loop; this wrapper owns local
 * durability semantics:
 *
 *   caller DedupeStore -> local Ingress queue -> SDK handler returns -> SDK ACK
 *
 * The self-written Feishu frame codec lives only under `src/test-support` and
 * is used by the mock server to exercise the official SDK; it is not a
 * production path.
 *
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  BotConnectionState,
  BotConnector,
  BotConnectorStatus,
  BotPlatform,
  InboundBotMessage,
  OutboundBotMessage,
} from "./contracts";
import {
  InboundPipeline,
  type DedupeStore,
  type DurableIngressStore,
  type InboundEventDraft,
  type InboundPipelineOptions,
  type IngressMetrics,
} from "./ingress";
import {
  NOOP_BOT_LOGGER,
  redactSecretValues,
  safeErrorMessage,
  type BotConnectorLogger,
} from "./logger";
import {
  asNumber,
  asString,
  fetchHttpClient,
  parseJsonObject,
  type HttpClient,
  type HttpRequest,
} from "./http";

const FEISHU_DEFAULT_DOMAIN = "https://open.feishu.cn";
const FEISHU_DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const FEISHU_DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const FEISHU_MESSAGE_EVENT = "im.message.receive_v1";

export interface AccessTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}

/** Exchanges app credentials for tenant_access_token and caches it. */
export class FeishuTenantTokenProvider implements AccessTokenProvider {
  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl: string,
    private readonly httpClient: HttpClient,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async getToken(signal?: AbortSignal): Promise<string> {
    if (this.token !== null && this.nowMs() < this.expiresAtMs - 60_000) {
      return this.token;
    }

    const request: HttpRequest = {
      url: joinUrl(this.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal"),
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    };
    if (signal) {
      request.signal = signal;
    }
    const response = await this.httpClient(request);
    const body = parseJsonObject(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `feishu tenant_access_token request failed (HTTP ${response.status}, code ${asNumber(body?.code) ?? -1})`,
      );
    }
    if (!body || body.code !== 0) {
      throw new Error(
        `feishu tenant_access_token request failed (code ${asNumber(body?.code) ?? -1})`,
      );
    }
    const token = asString(body.tenant_access_token);
    if (!token) {
      throw new Error("feishu tenant_access_token response is missing tenant_access_token");
    }
    const expireSeconds = asNumber(body.expire) ?? 7_200;
    this.token = token;
    this.expiresAtMs = this.nowMs() + Math.max(0, expireSeconds) * 1_000;
    return token;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }
}

export interface FeishuBotConnectorOptions {
  appId: string;
  appSecret: string;
  deviceId: string;
  /** Defaults to https://open.feishu.cn. Tests point this at a local mock server. */
  domain?: string;
  httpClient?: HttpClient;
  tokenProvider?: AccessTokenProvider;
  dedupeStore?: DedupeStore;
  ingressStore?: DurableIngressStore;
  logger?: BotConnectorLogger;
  ingressCapacity?: number;
  /**
   * When false, listeners registered through `onMessage` are not dispatched
   * automatically; the caller must consume `drainIngress()` itself.
   */
  autoDispatchIngress?: boolean;
  /** Passed to the official SDK as `wsConfig.pingTimeout` seconds. */
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Official SDK log level. Ignored unless a BotConnectorLogger is supplied. */
  sdkLoggerLevel?: Lark.LoggerLevel;
  now?: () => Date;
}

export interface OfficialFeishuConnectorMetrics extends IngressMetrics {
  connectAttempts: number;
  reconnectEvents: number;
  terminalErrors: number;
}

/** Production Feishu connector: official SDK WSClient + local ingress pipeline. */
export function createFeishuBotConnector(
  options: FeishuBotConnectorOptions,
): OfficialFeishuConnector {
  return new OfficialFeishuConnector(options);
}

/**
 * Wraps the official Feishu WSClient while keeping our BotConnector contract,
 * persistent dedupe, ingress queue and "persist before ACK" ordering.
 */
export class OfficialFeishuConnector implements BotConnector {
  readonly platform: BotPlatform = "feishu";

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly domain: string;
  private readonly logger: BotConnectorLogger;
  private readonly sdkLoggerLevel: Lark.LoggerLevel;
  private readonly sdkLogger: Lark.Logger;
  private readonly heartbeatTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly now: () => Date;
  private readonly httpClient: HttpClient;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly pipeline: InboundPipeline;
  private readonly connectionMetrics = {
    connectAttempts: 0,
    reconnectEvents: 0,
    terminalErrors: 0,
  };

  private wsClient: Lark.WSClient | null = null;
  private state: BotConnectionState = "disconnected";
  private stopped = true;
  private runId = 0;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(options: FeishuBotConnectorOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.domain = options.domain ?? FEISHU_DEFAULT_DOMAIN;
    this.logger = options.logger ?? NOOP_BOT_LOGGER;
    this.sdkLoggerLevel = options.sdkLoggerLevel ?? Lark.LoggerLevel.error;
    this.sdkLogger = createRedactingSdkLogger(this.logger, [this.appSecret]);
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? FEISHU_DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? FEISHU_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.httpClient = options.httpClient ?? fetchHttpClient;
    const now = options.now;
    this.tokenProvider =
      options.tokenProvider ??
      new FeishuTenantTokenProvider(
        this.appId,
        this.appSecret,
        this.domain,
        this.httpClient,
        now ? () => now().getTime() : Date.now,
      );

    const pipelineOptions: InboundPipelineOptions = {
      platform: this.platform,
      deviceId: options.deviceId,
      logger: this.logger,
    };
    if (options.dedupeStore) pipelineOptions.dedupeStore = options.dedupeStore;
    if (options.ingressStore) pipelineOptions.ingressStore = options.ingressStore;
    if (options.ingressCapacity !== undefined)
      pipelineOptions.ingressCapacity = options.ingressCapacity;
    if (options.autoDispatchIngress !== undefined) {
      pipelineOptions.autoDispatchIngress = options.autoDispatchIngress;
    }
    this.pipeline = new InboundPipeline(pipelineOptions);
  }

  async connect(): Promise<void> {
    if (!this.stopped) {
      return this.connectPromise ?? Promise.resolve();
    }
    if (!FEISHU_APP_ID_PATTERN.test(this.appId)) {
      throw new Error("feishu appId must match cli_ + 16 hex characters (official SDK validation)");
    }
    if (!this.appSecret) {
      throw new Error("feishu appSecret is required");
    }

    this.stopped = false;
    this.state = "connecting";
    this.lastError = null;
    this.runId += 1;
    const runId = this.runId;
    this.connectionMetrics.connectAttempts += 1;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    const eventDispatcher = new Lark.EventDispatcher({
      logger: this.sdkLogger,
      loggerLevel: this.sdkLoggerLevel,
    });
    eventDispatcher.register({
      [FEISHU_MESSAGE_EVENT]: async (data: unknown): Promise<void> => {
        if (!this.isActiveRun(runId)) {
          return;
        }
        const draft = mapFeishuInboundEvent(data, this.now());
        if (draft) {
          await this.pipeline.accept(draft);
        }
      },
    } as unknown as Lark.EventHandles);

    const wsOptions: ConstructorParameters<typeof Lark.WSClient>[0] = {
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      logger: this.sdkLogger,
      loggerLevel: this.sdkLoggerLevel,
      autoReconnect: true,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      onReady: () => {
        if (!this.isActiveRun(runId)) {
          return;
        }
        this.markConnected();
      },
      onReconnected: () => {
        if (!this.isActiveRun(runId)) {
          return;
        }
        this.markConnected();
      },
      onReconnecting: () => {
        if (!this.isActiveRun(runId)) {
          return;
        }
        this.state = "degraded";
        this.connectionMetrics.reconnectEvents += 1;
        this.logger.warn("feishu long connection reconnecting", { platform: this.platform });
      },
      onError: (error: Error) => {
        if (!this.isActiveRun(runId)) {
          return;
        }
        this.stopWithError(error);
      },
    };
    if (this.heartbeatTimeoutMs > 0) {
      wsOptions.wsConfig = {
        pingTimeout: Math.max(1, Math.ceil(this.heartbeatTimeoutMs / 1_000)),
      };
    }

    try {
      const wsClient = new Lark.WSClient(wsOptions);
      this.wsClient = wsClient;
      await wsClient.start({ eventDispatcher });
    } catch (error) {
      if (this.isActiveRun(runId)) {
        this.stopWithError(error);
      }
    }
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.runId += 1;
    this.state = "disconnected";
    this.lastError = null;

    const client = this.wsClient;
    this.wsClient = null;
    if (client) {
      try {
        client.close({ force: true });
      } catch {
        // Best-effort shutdown.
      }
    }
    this.rejectPendingConnect(new Error("bot connector disconnected"));
    this.logger.info("feishu long connection disconnected", { platform: this.platform });
  }

  getStatus(): BotConnectorStatus {
    return {
      platform: this.platform,
      state: this.currentState(),
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  getMetrics(): Readonly<OfficialFeishuConnectorMetrics> {
    return { ...this.pipeline.getMetrics(), ...this.connectionMetrics };
  }

  getIngressSize(): number {
    return this.pipeline.getIngressSize();
  }

  /** Removes and returns queued messages; useful when autoDispatchIngress is false. */
  drainIngress(): InboundBotMessage[] {
    return this.pipeline.drainIngress();
  }

  onMessage(listener: (message: InboundBotMessage) => void): () => void {
    return this.pipeline.onMessage(listener);
  }

  async send(message: OutboundBotMessage): Promise<void> {
    if (message.platform !== this.platform) {
      throw new Error(
        `message platform ${message.platform} does not match connector platform ${this.platform}`,
      );
    }
    if (message.attachments && message.attachments.length > 0) {
      throw new Error("feishu attachments are not supported by the phase 0.5 adapter skeleton");
    }
    const token = await this.tokenProvider.getToken();
    const request: HttpRequest = {
      url: joinUrl(this.domain, "/open-apis/im/v1/messages?receive_id_type=chat_id"),
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: message.conversationId,
        msg_type: "text",
        content: JSON.stringify({ text: message.text }),
      }),
    };
    const response = await this.httpClient(request);
    const body = parseJsonObject(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `feishu message send failed (HTTP ${response.status}, code ${asNumber(body?.code) ?? -1})`,
      );
    }
    const code = asNumber(body?.code) ?? -1;
    if (code !== 0) {
      throw new Error(`feishu message send failed (code ${code})`);
    }
  }

  private markConnected(): void {
    this.state = "connected";
    this.lastError = null;
    this.lastConnectedAt = this.now().toISOString();
    if (this.connectResolve) {
      const resolve = this.connectResolve;
      this.connectResolve = null;
      this.connectReject = null;
      this.connectPromise = null;
      resolve();
    }
  }

  private stopWithError(error: unknown): void {
    this.stopped = true;
    this.runId += 1;
    this.state = "disconnected";
    this.lastError = redactSecretValues(safeErrorMessage(error), [this.appSecret]);
    this.connectionMetrics.terminalErrors += 1;
    const client = this.wsClient;
    this.wsClient = null;
    if (client) {
      try {
        client.close({ force: true });
      } catch {
        // Best-effort shutdown.
      }
    }
    this.logger.error("feishu long connection stopped", {
      platform: this.platform,
      error: this.lastError,
    });
    // Reject with the redacted message, not the raw SDK error, so a caller
    // logging the rejection cannot leak an echoed AppSecret.
    this.rejectPendingConnect(new Error(this.lastError ?? "feishu connector failed"));
  }

  private rejectPendingConnect(error: Error): void {
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
    if (reject) {
      reject(error);
    }
  }

  private isActiveRun(runId: number): boolean {
    return !this.stopped && runId === this.runId;
  }

  private currentState(): BotConnectionState {
    if (this.stopped) {
      return "disconnected";
    }
    const status = this.wsClient?.getConnectionStatus();
    if (!status) {
      return this.state;
    }
    switch (status.state) {
      case "connected":
        return "connected";
      case "connecting":
        return "connecting";
      case "reconnecting":
        return "degraded";
      case "failed":
        return "disconnected";
      case "idle":
        return this.state === "connected" ? "connected" : this.state;
      default:
        return this.state;
    }
  }
}

interface FeishuMessageEventData {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
}

/**
 * Maps the official SDK's flattened im.message.receive_v1 handler payload.
 * The SDK merges header fields and event fields into one object.
 */
export function mapFeishuInboundEvent(
  data: unknown,
  now: Date = new Date(),
): InboundEventDraft | null {
  const event = data as FeishuMessageEventData;
  if (event.event_type && event.event_type !== FEISHU_MESSAGE_EVENT) {
    return null;
  }
  const message = event.message;
  if (!message) {
    throw new Error("feishu message event is missing event.message");
  }
  // Feishu docs explicitly recommend message_id (not event_id) for idempotency:
  // https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive
  const eventId = message.message_id ?? event.event_id;
  if (!eventId) {
    throw new Error("feishu message event is missing message.message_id");
  }
  const senderId = event.sender?.sender_id;
  const receivedAtMs = Number(message.create_time ?? event.create_time);
  const receivedAt = Number.isFinite(receivedAtMs)
    ? new Date(receivedAtMs).toISOString()
    : now.toISOString();

  return {
    eventId,
    platformUserId: senderId?.open_id ?? senderId?.user_id ?? senderId?.union_id ?? "",
    conversationId: message.chat_id ?? "",
    text: extractFeishuText(message),
    receivedAt,
    raw: data,
  };
}

function extractFeishuText(message: { message_type?: string; content?: string }): string {
  if (message.message_type !== "text" || !message.content) {
    return "";
  }
  try {
    const content = JSON.parse(message.content) as { text?: unknown };
    return typeof content.text === "string" ? content.text : "";
  } catch {
    return "";
  }
}

function createRedactingSdkLogger(
  logger: BotConnectorLogger,
  knownSecrets: readonly string[],
): Lark.Logger {
  const emit = (level: "error" | "warn" | "info" | "debug", args: unknown[]): void => {
    const text = redactSecretValues(formatLogArgs(args), knownSecrets);
    if (level === "error") {
      logger.error(text);
    } else if (level === "warn") {
      logger.warn(text);
    } else if (level === "info") {
      logger.info(text);
    } else {
      logger.debug(text);
    }
  };
  return {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
    trace: (...args: unknown[]) => emit("debug", args),
  };
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Error) {
        return arg.message;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, 1_000);
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

export type FeishuConnectorStatus = BotConnectorStatus;
