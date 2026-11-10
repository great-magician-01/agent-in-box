/**
 * Platform-neutral bot contracts. Feishu and QQ adapters own their official protocol details.
 */

export type BotPlatform = "feishu" | "qq";

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
