/**
 * Platform-neutral bot contracts. Feishu and QQ adapters own their official protocol details.
 */

/**
 * Platforms are open-ended strings: new adapters (OneBot, Discord, Telegram,
 * ...) can be added without changing the core framework. The built-in literals
 * remain visible as editor hints while arbitrary registered ids are accepted.
 */
export const BUILT_IN_BOT_PLATFORMS = ["feishu", "qq"] as const;
export type BuiltInBotPlatform = (typeof BUILT_IN_BOT_PLATFORMS)[number];
export type BotPlatform = BuiltInBotPlatform | (string & {});
export const FEISHU_PLATFORM: BuiltInBotPlatform = "feishu";
export const QQ_PLATFORM: BuiltInBotPlatform = "qq";

export type BotConnectionState = "disconnected" | "connecting" | "connected" | "degraded";

export interface InboundBotMessage {
  platform: BotPlatform;
  eventId: string;
  platformUserId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
  raw: unknown;
}

export interface OutboundBotMessage {
  platform: BotPlatform;
  conversationId: string;
  text: string;
  attachments?: readonly string[];
}

export interface BotConnectorStatus {
  platform: BotPlatform;
  state: BotConnectionState;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export interface BotConnector {
  readonly platform: BotPlatform;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): BotConnectorStatus;
  send(message: OutboundBotMessage): Promise<void>;
  onMessage(listener: (message: InboundBotMessage) => void): () => void;
  /** Present on the built-in adapters; lets durable consumers clear the memory queue. */
  drainIngress?(): InboundBotMessage[];
}

/**
 * Deduplication key is scoped per platform and bound device.
 * Event IDs must be persisted before a task is created.
 */
export function dedupKey(platform: BotPlatform, deviceId: string, eventId: string): string {
  if (!deviceId || !eventId) {
    throw new Error("deviceId and eventId are required for deduplication");
  }
  return `${platform}:${deviceId}:${eventId}`;
}

export function isAuthorizedUser(
  allowedUserIds: ReadonlySet<string>,
  platformUserId: string,
): boolean {
  return allowedUserIds.has(platformUserId);
}
