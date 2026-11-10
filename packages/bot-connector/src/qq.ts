/**
 * QQ bot WebSocket gateway adapter.
 *
 * Aligned with the official QQ docs and the active official plugin/SDK:
 * - tencent-connect/openclaw-qqbot (uses @tencent-connect/qqbot-nodejs)
 * - @satorijs/adapter-qq used by the Koishi QQ adapter
 *
 * Wire behavior:
 * - access token: POST /app/getAppAccessToken (plugins use bots.qq.com;
 *   current docs use api.bot.qq.com; both are configurable)
 * - gateway: GET /gateway (Authorization: QQBot {token})
 * - Hello op 10 -> Identify op 2 -> READY / Resume op 6 -> RESUMED
 * - heartbeat op 1 with the latest `s`; ACK is op 11
 * - event payload: { id, op: 0, s, t, d }
 * - inbound dedupe by message id (same convention as active plugins)
 *
 * Docs:
 * - https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 * - https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html
 * - https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 * - https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
 * Plugins:
 * - https://github.com/tencent-connect/openclaw-qqbot
 * - https://github.com/satorijs/satori/tree/master/packages/adapter-qq
 */

import {
  ManagedBotConnection,
  TerminalBotError,
  type BotProtocol,
  type BotProtocolSession,
  type DedupeStore,
  type InboundEventDraft,
  type ManagedBotConnectionOptions,
  type ProtocolContext,
  type ResolvedBotConnection,
} from "./connection";
import type { BotConnectorLogger } from "./logger";
import type { BotConnectorStatus, InboundBotMessage, OutboundBotMessage } from "./contracts";
import {
  asNumber,
  asRecord,
  asString,
  fetchHttpClient,
  parseJsonObject,
  type HttpClient,
  type HttpRequest,
} from "./http";
import type { ReconnectPolicy } from "./reconnect";
import { DefaultWsConnector, type WsCloseInfo, type WsConnector, type WsData } from "./ws";

const QQ_DEFAULT_API_BASE = "https://api.bot.qq.com";
/**
 * Active official plugins (tencent-connect/openclaw-qqbot and the Satori/Koishi
 * QQ adapter) still request tokens from bots.qq.com, while the current QQ docs
 * show api.bot.qq.com. Both are configurable; the implementation follows the
 * active plugin default for token retrieval.
 */
const QQ_DEFAULT_TOKEN_BASE = "https://bots.qq.com";
/** GROUP_AND_C2C_EVENT: C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, GROUP_MESSAGE_CREATE. */
const QQ_GROUP_AND_C2C_INTENT = 1 << 25;
const QQ_DEFAULT_HEARTBEAT_MS = 45_000;
const QQ_HEARTBEAT_MIN_MS = 10;
const QQ_RATE_LIMIT_RECONNECT_DELAY_MS = 60_000;

const QQ_MESSAGE_EVENT_TYPES = new Set([
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
  "GROUP_MESSAGE_CREATE",
]);

// Follow the official error table. 4914/4915 are also fatal in the active
// Tencent SDK. 4004/4006/4007/4009/4900-4913 are recoverable (token refresh,
// session reset) and are handled in QqProtocolSession.onClose instead.
const QQ_TERMINAL_CLOSE_CODES = new Set([
  4001, // invalid opcode
  4002, // invalid payload
  4010, // invalid shard
  4011, // too many guilds
  4012, // invalid version
  4013, // invalid intent
  4014, // disallowed intent
  4914, // bot removed / sandbox-only state
  4915, // bot banned
]);

export interface QqAccessTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Drop a cached token after an invalid-token/expired-session close. */
  invalidate?(): void;
}

export class QqAccessTokenProviderImpl implements QqAccessTokenProvider {
  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly appId: string,
    private readonly clientSecret: string,
    private readonly apiBase: string,
    private readonly httpClient: HttpClient,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async getToken(signal?: AbortSignal): Promise<string> {
    if (this.token !== null && this.nowMs() < this.expiresAtMs - 60_000) {
      return this.token;
    }

    const request: HttpRequest = {
      url: joinApiUrl(this.apiBase, "/app/getAppAccessToken"),
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    };
    if (signal) {
      request.signal = signal;
    }
    const response = await this.httpClient(request);
    if (response.status < 200 || response.status >= 300) {
      if (response.status >= 400 && response.status < 500) {
        throw new TerminalBotError(`qq access token request rejected (HTTP ${response.status})`);
      }
      throw new Error(`qq access token request failed (HTTP ${response.status})`);
    }

    const body = parseJsonObject(response.body);
    const token = asString(body?.access_token);
    if (!token) {
      const code = asNumber(body?.code) ?? -1;
      // 100016 invalid appid/secret, 100007 invalid appid/bot state, 10004 unknown bot.
      if (code === 100016 || code === 100007 || code === 10004) {
        throw new TerminalBotError(`qq access token request rejected (code ${code})`);
      }
      throw new Error(`qq access token request failed (code ${code})`);
    }
    const expiresSeconds = asNumber(body?.expires_in) ?? 7_200;
    this.token = token;
    this.expiresAtMs = this.nowMs() + Math.max(0, expiresSeconds) * 1_000;
    return token;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }
}

export interface QqResumeState {
  sessionId: string | undefined;
  lastSeq: number;
}

export interface QqBotConnectorOptions {
  appId: string;
  clientSecret: string;
  deviceId: string;
  /** Defaults to https://api.bot.qq.com. Tests point this at a local mock server. */
  apiBase?: string;
  /** Defaults to https://bots.qq.com, or apiBase when apiBase is overridden. */
  tokenBaseUrl?: string;
  /** Delay after close code 4008; default 60s. */
  rateLimitReconnectDelayMs?: number;
  intents?: number;
  shard?: readonly [number, number];
  httpClient?: HttpClient;
  wsConnector?: WsConnector;
  tokenProvider?: QqAccessTokenProvider;
  dedupeStore?: DedupeStore;
  reconnect?: Partial<ReconnectPolicy>;
  logger?: BotConnectorLogger;
  ingressCapacity?: number;
  autoDispatchIngress?: boolean;
  heartbeatTimeoutMs?: number;
  now?: () => Date;
  random?: () => number;
}

/** QQ message API needs to know whether the target is a user or a group. */
export type QqConversationScene = "c2c" | "group";

/**
 * Conversation IDs are prefixed by scene so an outbound reply can reuse the
 * exact ID returned by InboundBotMessage.
 */
export function qqConversationId(scene: QqConversationScene, openId: string): string {
  if (!openId) {
    throw new Error("QQ openId is required");
  }
  return `${scene}:${openId}`;
}

export function parseQqConversationId(value: string): {
  scene: QqConversationScene;
  openId: string;
} {
  if (value.startsWith("group:")) {
    return { scene: "group", openId: value.slice("group:".length) };
  }
  if (value.startsWith("c2c:")) {
    return { scene: "c2c", openId: value.slice("c2c:".length) };
  }
  // Unprefixed historical IDs are treated as C2C users.
  return { scene: "c2c", openId: value };
}

export interface QqOutboundBotMessage extends OutboundBotMessage {
  /** Passive reply msg_id from the inbound event's d.id (valid for a short window). */
  replyToMessageId?: string;
  /** Reply sequence used with msg_id; defaults to 1. */
  msgSeq?: number;
}

/** Builds an outbound passive reply from a QQ inbound message. */
export function qqPassiveReply(inbound: InboundBotMessage, text: string): QqOutboundBotMessage {
  const payload = inbound.raw as QqGatewayPayload;
  const rawMessage = asRecord(payload.d);
  const replyToMessageId = asString(rawMessage?.id);
  const message: QqOutboundBotMessage = {
    platform: "qq",
    conversationId: inbound.conversationId,
    text,
  };
  if (replyToMessageId) {
    message.replyToMessageId = replyToMessageId;
  }
  return message;
}

export function createQqBotConnector(options: QqBotConnectorOptions): ManagedBotConnection {
  const apiBase = options.apiBase ?? QQ_DEFAULT_API_BASE;
  const tokenBaseUrl = options.tokenBaseUrl ?? (options.apiBase ? apiBase : QQ_DEFAULT_TOKEN_BASE);
  const httpClient = options.httpClient ?? fetchHttpClient;
  const now = options.now;
  const tokenProvider =
    options.tokenProvider ??
    new QqAccessTokenProviderImpl(
      options.appId,
      options.clientSecret,
      tokenBaseUrl,
      httpClient,
      now ? () => now().getTime() : Date.now,
    );
  const protocol = new QqProtocol({
    apiBase,
    httpClient,
    tokenProvider,
    intents: options.intents ?? QQ_GROUP_AND_C2C_INTENT,
    shard: options.shard ?? [0, 1],
    rateLimitReconnectDelayMs:
      options.rateLimitReconnectDelayMs ?? QQ_RATE_LIMIT_RECONNECT_DELAY_MS,
  });

  const managedOptions: ManagedBotConnectionOptions = {
    protocol,
    deviceId: options.deviceId,
    wsConnector: options.wsConnector ?? new DefaultWsConnector(),
  };
  if (options.dedupeStore) managedOptions.dedupeStore = options.dedupeStore;
  if (options.reconnect) managedOptions.reconnect = options.reconnect;
  if (options.logger) managedOptions.logger = options.logger;
  if (options.ingressCapacity !== undefined)
    managedOptions.ingressCapacity = options.ingressCapacity;
  if (options.autoDispatchIngress !== undefined) {
    managedOptions.autoDispatchIngress = options.autoDispatchIngress;
  }
  if (options.heartbeatTimeoutMs !== undefined) {
    managedOptions.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
  }
  if (options.now) managedOptions.now = options.now;
  if (options.random) managedOptions.random = options.random;
  return new ManagedBotConnection(managedOptions);
}

interface QqProtocolOptions {
  apiBase: string;
  httpClient: HttpClient;
  tokenProvider: QqAccessTokenProvider;
  intents: number;
  shard: readonly [number, number];
  rateLimitReconnectDelayMs: number;
}

export class QqProtocol implements BotProtocol {
  readonly platform = "qq" as const;
  private accessToken = "";
  private readonly resumeState: QqResumeState = { sessionId: undefined, lastSeq: 0 };

  constructor(private readonly options: QqProtocolOptions) {}

  async resolveConnection(signal: AbortSignal): Promise<ResolvedBotConnection> {
    const token = await this.options.tokenProvider.getToken(signal);
    this.accessToken = token;
    const request: HttpRequest = {
      url: joinApiUrl(this.options.apiBase, "/gateway"),
      method: "GET",
      headers: { Authorization: `QQBot ${token}` },
      signal,
    };
    const response = await this.options.httpClient(request);
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        throw new TerminalBotError(`qq gateway request rejected (HTTP ${response.status})`);
      }
      throw new Error(`qq gateway request failed (HTTP ${response.status})`);
    }
    const body = parseJsonObject(response.body);
    const url = asString(body?.url);
    if (!url) {
      const code = asNumber(body?.err_code) ?? asNumber(body?.code) ?? -1;
      throw new Error(`qq gateway response is missing url (code ${code})`);
    }
    return { url };
  }

  createSession(context: ProtocolContext): BotProtocolSession {
    return new QqProtocolSession(
      context,
      this.accessToken,
      this.options.intents,
      this.options.shard,
      this.resumeState,
      () => this.options.tokenProvider.invalidate?.(),
    );
  }

  getCloseReconnectDelayMs(code: number): number | undefined {
    return code === 4008 ? this.options.rateLimitReconnectDelayMs : undefined;
  }

  async sendMessage(message: OutboundBotMessage): Promise<void> {
    if (message.attachments && message.attachments.length > 0) {
      throw new Error("qq attachments are not supported by the phase 0.5 adapter skeleton");
    }
    const typed = message as QqOutboundBotMessage;
    const { scene, openId } = parseQqConversationId(message.conversationId);
    if (scene !== "group" && scene !== "c2c") {
      throw new Error(`unsupported qq conversation scene: ${String(scene)}`);
    }
    const token = await this.options.tokenProvider.getToken();
    const path =
      scene === "group"
        ? `/v2/groups/${encodeURIComponent(openId)}/messages`
        : `/v2/users/${encodeURIComponent(openId)}/messages`;

    const body: Record<string, unknown> = {
      msg_type: 0,
      content: message.text,
    };
    if (typed.replyToMessageId) {
      body.msg_id = typed.replyToMessageId;
      body.msg_seq = typed.msgSeq ?? 1;
    }

    const response = await this.options.httpClient({
      url: joinApiUrl(this.options.apiBase, path),
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const responseBody = parseJsonObject(response.body);
    const errCode = asNumber(responseBody?.err_code);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      (errCode !== undefined && errCode !== 0)
    ) {
      throw new Error(
        `qq message send failed (HTTP ${response.status}, err_code ${errCode ?? -1})`,
      );
    }
  }

  isTerminalClose(code: number): boolean {
    return QQ_TERMINAL_CLOSE_CODES.has(code);
  }
}

export type QqConnectorStatus = BotConnectorStatus;

interface QqGatewayPayload {
  id?: string;
  op?: number;
  s?: number;
  t?: string;
  d?: unknown;
}

class QqProtocolSession implements BotProtocolSession {
  constructor(
    private readonly context: ProtocolContext,
    private readonly accessToken: string,
    private readonly intents: number,
    private readonly shard: readonly [number, number],
    private readonly resumeState: QqResumeState,
    private readonly onInvalidateToken: () => void,
  ) {}

  onOpen(): void {
    // The gateway sends Hello first; Identify/Resume is sent on op 10.
  }

  async onMessage(data: WsData): Promise<void> {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const payload = parseJsonObject(text);
    if (!payload) {
      throw new Error("qq gateway frame payload is not a JSON object");
    }
    const event = payload as QqGatewayPayload;
    const op = asNumber(event.op);
    if (op === undefined) {
      return;
    }

    switch (op) {
      case 10:
        this.handleHello(event);
        return;
      case 11:
        return;
      case 7:
        this.context.requestReconnect("qq gateway requested reconnect");
        return;
      case 9:
        // `d` indicates whether the session is still resumable.
        if (event.d !== true) {
          this.resetSession();
          this.onInvalidateToken();
        }
        this.context.requestReconnect("qq gateway invalid session");
        return;
      case 0:
        await this.handleDispatch(event);
        return;
      default:
        return;
    }
  }

  onClose(info: WsCloseInfo): void {
    // Align recoverable close handling with the active Tencent/openclaw SDK:
    // - 4004 invalid token: refresh token, re-identify
    // - 4006/4007/4009: session cannot be resumed, refresh token, re-identify
    // - 4900-4913 internal server errors: re-identify with a fresh token
    // 4008 is rate limiting: keep the session/token and reconnect after the
    // protocol-provided delay.
    if (info.code === 4004 || info.code === 4006 || info.code === 4007 || info.code === 4009) {
      this.resetSession();
      this.onInvalidateToken();
      return;
    }
    if (info.code >= 4900 && info.code <= 4913) {
      this.resetSession();
      this.onInvalidateToken();
    }
  }

  private resetSession(): void {
    this.resumeState.sessionId = undefined;
    this.resumeState.lastSeq = 0;
  }

  private handleHello(event: QqGatewayPayload): void {
    const data = asRecord(event.d);
    const interval = asNumber(data?.heartbeat_interval);
    const heartbeatMs =
      interval !== undefined && interval > 0
        ? Math.max(interval, QQ_HEARTBEAT_MIN_MS)
        : QQ_DEFAULT_HEARTBEAT_MS;
    this.context.setHeartbeat(heartbeatMs, () => this.sendHeartbeat());

    if (this.resumeState.sessionId && this.resumeState.lastSeq > 0) {
      this.sendResume();
      return;
    }
    this.sendIdentify();
  }

  private sendIdentify(): void {
    this.context.sendRaw(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents: this.intents,
          shard: [this.shard[0], this.shard[1]],
          properties: {
            $os: process.platform,
            $browser: "agent-in-box",
            $device: "agent-in-box",
          },
        },
      }),
    );
  }

  private sendResume(): void {
    this.context.sendRaw(
      JSON.stringify({
        op: 6,
        d: {
          token: `QQBot ${this.accessToken}`,
          session_id: this.resumeState.sessionId,
          seq: this.resumeState.lastSeq,
        },
      }),
    );
  }

  private sendHeartbeat(): void {
    this.context.sendRaw(
      JSON.stringify({
        op: 1,
        d: this.resumeState.lastSeq > 0 ? this.resumeState.lastSeq : null,
      }),
    );
  }

  private async handleDispatch(event: QqGatewayPayload): Promise<void> {
    const eventType = event.t;
    const data = asRecord(event.d);
    const seq = asNumber(event.s);

    if (eventType === "READY") {
      const sessionId = asString(data?.session_id);
      if (sessionId) {
        this.resumeState.sessionId = sessionId;
      }
      this.resumeState.lastSeq = seq ?? 1;
      this.context.markReady();
      return;
    }

    if (eventType === "RESUMED") {
      if (seq !== undefined) {
        this.resumeState.lastSeq = Math.max(this.resumeState.lastSeq, seq);
      }
      this.context.markReady();
      return;
    }

    if (eventType && QQ_MESSAGE_EVENT_TYPES.has(eventType)) {
      const draft = mapQqInboundEvent(event);
      if (draft) {
        await this.context.acceptInbound(draft);
      }
    }

    // Advance resume position only after durable local admission/ignore.
    if (seq !== undefined) {
      this.resumeState.lastSeq = Math.max(this.resumeState.lastSeq, seq);
    }
  }
}

interface QqMessageEventPayload extends QqGatewayPayload {
  d?: {
    id?: string;
    content?: string;
    timestamp?: string;
    group_openid?: string;
    author?: {
      id?: string;
      user_openid?: string;
      member_openid?: string;
    };
  };
}

export function mapQqInboundEvent(
  payload: QqGatewayPayload,
  now: Date = new Date(),
): InboundEventDraft | null {
  const eventType = payload.t;
  if (!eventType || !QQ_MESSAGE_EVENT_TYPES.has(eventType)) {
    return null;
  }
  const message = payload.d as QqMessageEventPayload["d"];
  if (!message) {
    throw new Error("qq message event is missing d");
  }
  const messageId = asString(message.id) ?? asString(payload.id);
  if (!messageId) {
    throw new Error("qq message event is missing d.id");
  }
  // Active official plugins dedupe inbound messages by message id. `msg_idx`
  // identifies a quoted/referenced message element, not a delivery attempt.
  const eventId = messageId;

  const author = message.author;
  const groupOpenId = asString(message.group_openid);
  const userOpenId = asString(author?.user_openid);
  let conversationId: string;
  let platformUserId: string;
  if (groupOpenId) {
    conversationId = qqConversationId("group", groupOpenId);
    platformUserId = asString(author?.member_openid) ?? userOpenId ?? asString(author?.id) ?? "";
  } else if (userOpenId) {
    conversationId = qqConversationId("c2c", userOpenId);
    platformUserId = userOpenId;
  } else {
    throw new Error("qq message event has neither group_openid nor author.user_openid");
  }

  const timestamp = asString(message.timestamp);
  const parsedTimestamp = timestamp ? new Date(timestamp) : null;
  const receivedAt =
    parsedTimestamp && Number.isFinite(parsedTimestamp.getTime())
      ? parsedTimestamp.toISOString()
      : now.toISOString();

  return {
    eventId,
    platformUserId,
    conversationId,
    text: asString(message.content) ?? "",
    receivedAt,
    raw: payload,
  };
}

function joinApiUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
