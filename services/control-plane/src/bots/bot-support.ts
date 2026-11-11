import { createHash, randomBytes } from "node:crypto";
import type {
  BotAccountConfig,
  BotAccountRecord,
  BotChatKind,
  BotChatRecord,
  BotEventView,
  BotIdentityRecord,
  BotIdentityRole,
  BotPlatform,
  BotRuntimeState,
  BotTurnRecord,
  BotTurnStatus,
} from "@agent-in-box/protocol";
import { BOT_PLATFORMS } from "@agent-in-box/protocol";
import type {
  BotAccountsTable,
  BotChatsTable,
  BotEventsTable,
  BotIdentitiesTable,
  BotTurnsTable,
} from "../persistence/schema";

export const BOT_DEVICE_ID_KEY = "bot.deviceId";
export const BOT_ACTIVE_DEVICE_ID_KEY = "bot.activeDeviceId";
export const BOT_NOTIFICATION_CURSOR_KEY = "bot.notificationCursor";

export const MAX_BOT_TEXT_LENGTH = 4000;
const MAX_OUTBOUND_CHUNK = 3500;

export function isBotPlatform(value: unknown): value is BotPlatform {
  return typeof value === "string" && (BOT_PLATFORMS as readonly string[]).includes(value);
}

export function asBotPlatform(value: string): BotPlatform {
  return isBotPlatform(value) ? value : "feishu";
}

export function asRuntimeState(value: string): BotRuntimeState {
  return ["disabled", "disconnected", "connecting", "connected", "degraded"].includes(value)
    ? (value as BotRuntimeState)
    : "disconnected";
}

export function asIdentityRole(value: unknown): BotIdentityRole {
  return value === "admin" ? "admin" : "member";
}

export function asChatKind(value: unknown): BotChatKind {
  return value === "group" ? "group" : "p2p";
}

export function asTurnStatus(value: string): BotTurnStatus {
  return value === "completed" || value === "failed" ? value : "running";
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseAccountConfig(raw: string): BotAccountConfig {
  const value = parseJsonObject(raw);
  return {
    ...(typeof value.domain === "string" && value.domain ? { domain: value.domain } : {}),
    ...(typeof value.apiBase === "string" && value.apiBase ? { apiBase: value.apiBase } : {}),
    ...(typeof value.tokenBaseUrl === "string" && value.tokenBaseUrl
      ? { tokenBaseUrl: value.tokenBaseUrl }
      : {}),
    ...(typeof value.botUserId === "string" && value.botUserId
      ? { botUserId: value.botUserId }
      : {}),
    ...(typeof value.intents === "number" && Number.isInteger(value.intents)
      ? { intents: value.intents }
      : {}),
  };
}

export function toBotAccountRecord(row: BotAccountsTable): BotAccountRecord {
  return {
    id: row.id,
    platform: asBotPlatform(row.platform),
    name: row.name,
    enabled: row.enabled === 1,
    appId: row.app_id,
    credentialProviderId: row.credential_provider_id,
    config: parseAccountConfig(row.config_json),
    deviceId: row.device_id,
    state: asRuntimeState(row.state),
    lastConnectedAt: row.last_connected_at,
    lastError: row.last_error,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toBotIdentityRecord(row: BotIdentitiesTable): BotIdentityRecord {
  return {
    id: row.id,
    platform: asBotPlatform(row.platform),
    platformUserId: row.platform_user_id,
    displayName: row.display_name,
    role: asIdentityRole(row.role),
    bound: row.bound === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function toBotChatRecord(row: BotChatsTable): BotChatRecord {
  return {
    id: row.id,
    platform: asBotPlatform(row.platform),
    conversationId: row.conversation_id,
    kind: asChatKind(row.kind),
    title: row.title,
    allowed: row.allowed === 1,
    projectId: row.project_id,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function toBotTurnRecord(row: BotTurnsTable): BotTurnRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    platform: asBotPlatform(row.platform),
    platformConversationId: row.platform_conversation_id,
    localConversationId: row.local_conversation_id,
    userText: row.user_text,
    status: asTurnStatus(row.status),
    assistantText: row.assistant_text,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function toBotEventView(row: BotEventsTable): BotEventView {
  return {
    dedupKey: row.dedup_key,
    accountId: row.account_id,
    platform: asBotPlatform(row.platform),
    eventId: row.event_id,
    conversationId: row.conversation_id,
    text: row.text,
    state:
      row.state === "processing" || row.state === "processed" || row.state === "failed"
        ? row.state
        : "pending",
    attempts: row.attempts,
    lastError: row.last_error,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

export function splitBotText(text: string, maxLength = MAX_OUTBOUND_CHUNK): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    const candidate = rest.slice(0, maxLength);
    const boundary = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf(". "),
    );
    const cut = boundary > maxLength / 2 ? boundary + 1 : maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function normalizeBotCommandText(text: string): string {
  return text
    .replace(/@_user_\d+/g, " ")
    .replace(/@_all/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createAccessCode(): string {
  const raw = randomBytes(12).toString("hex").toUpperCase();
  return `AIB-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function hashAccessCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "已创建",
    waiting_resources: "等待资源",
    waiting_vm: "等待 VM",
    queued: "排队中",
    running: "运行中",
    waiting_approval: "等待审批",
    blocked: "已阻塞",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

export function platformLabel(platform: BotPlatform): string {
  return platform === "feishu" ? "飞书" : "QQ";
}
