import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { BotPlatform, TaskRecord } from "@agent-in-box/protocol";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { SettingsService } from "../settings/settings.service";
import { BotOutboundService } from "./bot-outbound.service";
import { BOT_NOTIFICATION_CURSOR_KEY, taskStatusLabel } from "./bot-support";

const NOTIFY_STATUSES = new Set([
  "waiting_resources",
  "waiting_vm",
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

const RELEVANT_TOPICS = [
  "task.created",
  "task.status_changed",
  "task.approval_requested",
  "task.approval_resolved",
  "task.human_verification_requested",
  "task.human_verification_resolved",
  "router.message",
  "router.status_changed",
];

export const BOT_NOTIFICATION_OPTIONS = Symbol("AGENT_IN_BOX_BOT_NOTIFICATION_OPTIONS");

export interface BotNotificationOptions {
  tickIntervalMs?: number;
  autoTick?: boolean;
  now?: () => Date;
}

interface OutboxRow {
  id: number;
  topic: string;
  payload_json: string;
  created_at: string;
}

interface TaskLinkRow {
  task_id: string;
  turn_id: string;
  account_id: string;
  platform: string;
  platform_conversation_id: string;
}

interface TurnRow {
  id: string;
  account_id: string;
  platform: string;
  platform_conversation_id: string;
  local_conversation_id: string;
  status: string;
  assistant_text: string | null;
}

@Injectable()
export class BotNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotNotificationService.name);
  private readonly tickIntervalMs: number;
  private readonly autoTick: boolean;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private cursor: number | null = null;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly settings: SettingsService,
    private readonly outbound: BotOutboundService,
    @Optional() @Inject(BOT_NOTIFICATION_OPTIONS) options: BotNotificationOptions = {},
  ) {
    const envTick = Number(process.env.AGENT_IN_BOX_BOT_NOTIFICATION_TICK_MS);
    this.tickIntervalMs = Math.max(
      100,
      options.tickIntervalMs ?? (Number.isFinite(envTick) && envTick > 0 ? envTick : 500),
    );
    this.autoTick = options.autoTick ?? true;
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
      await this.expireStaleTurns();
      await this.consume(200);
    } catch (error) {
      this.logger.error(
        `Bot notification poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async consume(limit = 200): Promise<number> {
    const cursor = await this.ensureCursor();
    const rows = await this.db
      .selectFrom("outbox")
      .select(["id", "topic", "payload_json", "created_at"])
      .where("id", ">", cursor)
      .where("topic", "in", RELEVANT_TOPICS)
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
    if (rows.length === 0) return 0;
    for (const row of rows as OutboxRow[]) {
      try {
        await this.handle(row);
      } catch (error) {
        this.logger.warn(
          `Bot notification for ${row.topic} #${row.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const last = rows[rows.length - 1]!.id;
    await this.settings.setJson(BOT_NOTIFICATION_CURSOR_KEY, last);
    this.cursor = last;
    return rows.length;
  }

  /**
   * A control-plane crash can leave a turn marked running after its Router
   * process is gone. Expire it so a later task cannot attach to a stale chat.
   */
  private async expireStaleTurns(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - 60 * 60_000).toISOString();
    await this.db
      .updateTable("bot_turns")
      .set({
        status: "failed",
        error_message: "机器人回合超时或控制平面重启",
        updated_at: nowIso(),
        completed_at: nowIso(),
      })
      .where("status", "=", "running")
      .where("updated_at", "<", cutoff)
      .execute();
  }

  private async ensureCursor(): Promise<number> {
    if (this.cursor !== null) return this.cursor;
    const stored = await this.settings.getJson<number>(BOT_NOTIFICATION_CURSOR_KEY);
    if (typeof stored === "number" && Number.isFinite(stored)) {
      this.cursor = stored;
      return stored;
    }
    // Start from the beginning rather than the latest id. Historical events
    // without a bot turn/task link are skipped by the handlers, while an event
    // written immediately before the first poll is never lost.
    this.cursor = 0;
    await this.settings.setJson(BOT_NOTIFICATION_CURSOR_KEY, this.cursor);
    return this.cursor;
  }

  private async handle(row: OutboxRow): Promise<void> {
    const payload = parseJson(row.payload_json);
    switch (row.topic) {
      case "task.created":
        await this.handleTaskCreated(payload);
        return;
      case "task.status_changed":
        await this.handleTaskStatus(payload);
        return;
      case "task.approval_requested":
        await this.handleApprovalRequested(payload);
        return;
      case "task.approval_resolved":
        await this.handleApprovalResolved(payload);
        return;
      case "task.human_verification_requested":
        await this.handleHumanVerificationRequested(payload);
        return;
      case "task.human_verification_resolved":
        await this.handleHumanVerificationResolved(payload);
        return;
      case "router.message":
        await this.handleRouterMessage(payload);
        return;
      case "router.status_changed":
        await this.handleRouterStatus(payload);
        return;
      default:
        return;
    }
  }

  private async handleTaskCreated(payload: Record<string, unknown>): Promise<void> {
    const task = asTask(payload.task);
    if (!task) return;
    const turn = await this.activeTurn(task.originConversationId);
    if (!turn) return;
    const inserted = await this.db
      .insertInto("bot_task_links")
      .values({
        task_id: task.id,
        turn_id: turn.id,
        account_id: turn.account_id,
        platform: turn.platform,
        platform_conversation_id: turn.platform_conversation_id,
        created_at: nowIso(),
      })
      .onConflict((conflict) => conflict.column("task_id").doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) return;
    await this.sendToTurn(turn, {
      text: [
        `已创建任务 ${task.id}`,
        `状态：${taskStatusLabel(task.status)}`,
        `目标：${truncate(task.objective, 400)}`,
        "后续进度、审批和结果会自动发送。",
      ].join("\n"),
      kind: "task-created",
      refId: task.id,
      dedupeKey: `task-created:${task.id}`,
    });
  }

  private async handleTaskStatus(payload: Record<string, unknown>): Promise<void> {
    const task = asTask(payload.task);
    const taskId = task?.id ?? stringValue(payload.taskId);
    const to = task?.status ?? stringValue(payload.to);
    if (!taskId || !to || !NOTIFY_STATUSES.has(to)) return;
    const link = await this.taskLink(taskId);
    if (!link) return;
    const updatedAt = task?.updatedAt ?? "";
    const lines = [`任务 ${taskId}：${taskStatusLabel(to)}`];
    if (task) {
      lines.push(`目标：${truncate(task.objective, 300)}`);
    }
    if (to === "completed") {
      const artifacts = await this.db
        .selectFrom("task_artifacts")
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("task_id", "=", taskId)
        .executeTakeFirst();
      lines.push(
        `摘要：${truncate(task?.latestSummary ?? "—", 500)}`,
        `产物：${Number(artifacts?.count ?? 0)} 个（可在 Web 任务详情中查看和校验）`,
      );
    } else if (to === "failed" || to === "blocked") {
      lines.push(`原因：${truncate(task?.errorMessage ?? task?.latestSummary ?? "—", 500)}`);
    } else if (to === "waiting_approval") {
      lines.push("请在 Web 或使用 /approve <审批ID> 处理待审批动作。");
    }
    await this.sendToLink(link, {
      text: lines.join("\n"),
      kind: "task-status",
      refId: taskId,
      dedupeKey: `task-status:${taskId}:${to}:${updatedAt || stringValue(payload.from) || ""}`,
    });
  }

  private async handleApprovalRequested(payload: Record<string, unknown>): Promise<void> {
    const taskId = stringValue(payload.taskId);
    const approvalId = stringValue(payload.approvalId);
    if (!taskId || !approvalId) return;
    const link = await this.taskLink(taskId);
    if (!link) return;
    const inserted = await this.db
      .insertInto("bot_approval_links")
      .values({
        approval_id: approvalId,
        task_id: taskId,
        account_id: link.account_id,
        platform: link.platform,
        platform_conversation_id: link.platform_conversation_id,
        created_at: nowIso(),
      })
      .onConflict((conflict) => conflict.column("approval_id").doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) return;
    await this.sendToLink(link, {
      text: [
        `任务 ${taskId} 需要审批。`,
        `动作：${stringValue(payload.actionType) ?? "未知"}`,
        `说明：${truncate(stringValue(payload.summary) ?? "—", 500)}`,
        `审批 ID：${approvalId}`,
        `管理员可回复 /approve ${approvalId} 或 /reject ${approvalId}，并按提示确认。`,
      ].join("\n"),
      kind: "approval-requested",
      refId: approvalId,
      dedupeKey: `approval-requested:${approvalId}`,
    });
  }

  private async handleApprovalResolved(payload: Record<string, unknown>): Promise<void> {
    const approvalId = stringValue(payload.approvalId);
    const status = stringValue(payload.status);
    if (!approvalId || !status) return;
    const resolvedBy = stringValue(payload.resolvedBy) ?? "";
    if (resolvedBy.startsWith("bot:")) return;
    const link = await this.db
      .selectFrom("bot_approval_links")
      .selectAll()
      .where("approval_id", "=", approvalId)
      .executeTakeFirst();
    if (!link) return;
    const account = await this.account(link.account_id);
    if (!account) return;
    await this.sendToTurn(
      {
        id: "",
        account_id: link.account_id,
        platform: link.platform,
        platform_conversation_id: link.platform_conversation_id,
        local_conversation_id: "",
        status: "completed",
        assistant_text: null,
      },
      {
        text: `审批 ${approvalId} 已${status === "approved" ? "批准" : status === "rejected" ? "拒绝" : "结束"}（${resolvedBy || "本地用户"}）。`,
        kind: "approval-resolved",
        refId: approvalId,
        dedupeKey: `approval-resolved:${approvalId}:${status}`,
      },
    );
  }

  private async handleHumanVerificationRequested(payload: Record<string, unknown>): Promise<void> {
    const taskId = stringValue(payload.taskId);
    const verificationId = stringValue(payload.verificationId);
    if (!taskId || !verificationId) return;
    const link = await this.taskLink(taskId);
    if (!link) return;
    const reason = stringValue(payload.reason) ?? "Worker 请求人工完成当前验证。";
    await this.sendToLink(link, {
      text: [
        `任务 ${taskId} 需要人工处理。`,
        `说明：${truncate(reason, 400)}`,
        "请在 Web 观察栏查看 VM 画面并完成扫码/验证码等操作；需要输入时使用「人工接管」。",
        `人工处理 ID：${verificationId}`,
        "处理完成后，在任务详情点击「人工已处理，恢复任务」。",
      ].join("\n"),
      kind: "human-verification-requested",
      refId: verificationId,
      dedupeKey: `human-verification-requested:${verificationId}`,
    });
  }

  private async handleHumanVerificationResolved(payload: Record<string, unknown>): Promise<void> {
    const taskId = stringValue(payload.taskId);
    const verificationId = stringValue(payload.verificationId);
    if (!taskId || !verificationId) return;
    const link = await this.taskLink(taskId);
    if (!link) return;
    const resolvedBy = stringValue(payload.resolvedBy) ?? "local-user";
    const note = stringValue(payload.note);
    await this.sendToLink(link, {
      text: `任务 ${taskId} 的人工处理已确认（${resolvedBy}）${note ? `：${truncate(note, 300)}` : "。"}任务已重新排队。`,
      kind: "human-verification-resolved",
      refId: verificationId,
      dedupeKey: `human-verification-resolved:${verificationId}`,
    });
  }

  private async handleRouterMessage(payload: Record<string, unknown>): Promise<void> {
    if (payload.role !== "assistant") return;
    const messageId = stringValue(payload.messageId);
    const conversationId = stringValue(payload.conversationId);
    if (!messageId || !conversationId) return;
    const turn = await this.activeTurn(conversationId);
    if (!turn) return;
    const message = await this.db
      .selectFrom("router_messages")
      .select(["content"])
      .where("id", "=", messageId)
      .executeTakeFirst();
    const content = message?.content?.trim();
    if (!content) return;
    const combined =
      `${turn.assistant_text ?? ""}${turn.assistant_text ? "\n" : ""}${content}`.slice(0, 200_000);
    await this.db
      .updateTable("bot_turns")
      .set({ assistant_text: combined, updated_at: nowIso() })
      .where("id", "=", turn.id)
      .execute();
    await this.sendToTurn(turn, {
      text: content,
      kind: "router-message",
      refId: messageId,
      dedupeKey: `router-message:${messageId}`,
    });
  }

  private async handleRouterStatus(payload: Record<string, unknown>): Promise<void> {
    const conversationId = stringValue(payload.conversationId);
    const status = stringValue(payload.status);
    if (!conversationId || (status !== "idle" && status !== "failed")) return;
    const turn = await this.activeTurn(conversationId);
    if (!turn) return;
    const now = nowIso();
    if (status === "idle") {
      await this.db
        .updateTable("bot_turns")
        .set({ status: "completed", updated_at: now, completed_at: now })
        .where("id", "=", turn.id)
        .execute();
      if (!turn.assistant_text) {
        await this.sendToTurn(turn, {
          text: "Router 回合已完成，没有生成文字回复。请在 Web 任务看板查看持久化状态和产物。",
          kind: "router-completed",
          refId: turn.id,
          dedupeKey: `router-completed:${turn.id}`,
        });
      }
      return;
    }
    const error = stringValue(payload.error) ?? "Router 回合失败";
    await this.db
      .updateTable("bot_turns")
      .set({
        status: "failed",
        error_message: error.slice(0, 1000),
        updated_at: now,
        completed_at: now,
      })
      .where("id", "=", turn.id)
      .execute();
    await this.sendToTurn(turn, {
      text: `Router 回合失败：${truncate(error, 800)}`,
      kind: "router-error",
      refId: turn.id,
      dedupeKey: `router-error:${turn.id}`,
    });
  }

  private async activeTurn(conversationId: string): Promise<TurnRow | null> {
    const row = await this.db
      .selectFrom("bot_turns")
      .select([
        "id",
        "account_id",
        "platform",
        "platform_conversation_id",
        "local_conversation_id",
        "status",
        "assistant_text",
      ])
      .where("local_conversation_id", "=", conversationId)
      .where("status", "=", "running")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  private async taskLink(taskId: string): Promise<TaskLinkRow | null> {
    const row = await this.db
      .selectFrom("bot_task_links")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row ?? null;
  }

  private async account(accountId: string): Promise<{ id: string; platform: BotPlatform } | null> {
    const row = await this.db
      .selectFrom("bot_accounts")
      .select(["id", "platform"])
      .where("id", "=", accountId)
      .executeTakeFirst();
    return row ? { id: row.id, platform: row.platform as BotPlatform } : null;
  }

  private async sendToTurn(
    turn: TurnRow,
    message: {
      text: string;
      kind: string;
      refId: string | null;
      dedupeKey: string;
    },
  ): Promise<void> {
    const account = await this.account(turn.account_id);
    if (!account) return;
    const chat = await this.db
      .selectFrom("bot_chats")
      .select("last_message_id")
      .where("platform", "=", turn.platform)
      .where("conversation_id", "=", turn.platform_conversation_id)
      .executeTakeFirst();
    await this.outbound.enqueue({
      accountId: turn.account_id,
      platform: account.platform,
      conversationId: turn.platform_conversation_id,
      text: message.text,
      kind: message.kind,
      refId: message.refId,
      dedupeKey: message.dedupeKey,
      replyToMessageId: chat?.last_message_id ?? null,
    });
  }

  private async sendToLink(
    link: TaskLinkRow,
    message: {
      text: string;
      kind: string;
      refId: string | null;
      dedupeKey: string;
    },
  ): Promise<void> {
    await this.sendToTurn(
      {
        id: "",
        account_id: link.account_id,
        platform: link.platform,
        platform_conversation_id: link.platform_conversation_id,
        local_conversation_id: "",
        status: "completed",
        assistant_text: null,
      },
      {
        text: message.text,
        kind: message.kind,
        refId: message.refId,
        dedupeKey: message.dedupeKey,
      },
    );
  }
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asTask(value: unknown): TaskRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (
    typeof task.id !== "string" ||
    typeof task.projectId !== "string" ||
    typeof task.vmId !== "string" ||
    typeof task.originConversationId !== "string" ||
    typeof task.objective !== "string" ||
    typeof task.status !== "string" ||
    typeof task.updatedAt !== "string"
  ) {
    return null;
  }
  return task as unknown as TaskRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
