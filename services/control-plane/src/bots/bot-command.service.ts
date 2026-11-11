import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  BotAccountRecord,
  BotIdentityRecord,
  BotPlatform,
  TaskRecord,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { TaskService } from "../persistence/services/task-service";
import { ApprovalService } from "../computer-use/approval.service";
import { ProjectService } from "../projects/project.service";
import { ResourceManagerService } from "../resources/resource-manager.service";
import { RouterRuntimeService } from "../router/router-runtime.service";
import { BotAccountService } from "./bot-account.service";
import { BotIdentityService, type BotAuthorization } from "./bot-identity.service";
import { BotOutboundService } from "./bot-outbound.service";
import { normalizeBotCommandText, platformLabel, taskStatusLabel } from "./bot-support";

const CONFIRM_TTL_MS = 2 * 60_000;
const MAX_ROUTER_TEXT = 20_000;

export interface BotInboundInput {
  accountId: string;
  platform: BotPlatform;
  eventId: string;
  dedupKey: string;
  platformUserId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
  raw: unknown;
  stale: boolean;
}

interface InboundContext {
  account: BotAccountRecord;
  details: {
    kind: "p2p" | "group";
    title: string;
    lastMessageId: string | null;
    mentioned: boolean;
  };
  authorization: BotAuthorization;
  replyToMessageId: string | null;
}

@Injectable()
export class BotCommandService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly accounts: BotAccountService,
    private readonly identities: BotIdentityService,
    private readonly outbound: BotOutboundService,
    private readonly router: RouterRuntimeService,
    private readonly tasks: TaskService,
    private readonly approvals: ApprovalService,
    private readonly projects: ProjectService,
    private readonly resources: ResourceManagerService,
  ) {}

  /** Returns false only when the event should be marked failed and not retried. */
  async handleInbound(input: BotInboundInput): Promise<boolean> {
    const account = await this.accounts.get(input.accountId).catch(() => null);
    if (!account || !account.enabled) return true;
    if (account.platform !== input.platform) return false;
    const details = inboundDetails(input.platform, input.raw, account.config.botUserId);
    if (details.kind === "group" && !details.mentioned) {
      // Group messages must explicitly address the bot. Ignoring them is safer
      // than acting on every message in a busy channel.
      return true;
    }

    const authorization = await this.identities.authorizeInbound({
      platform: input.platform,
      platformUserId: input.platformUserId,
      conversationId: input.conversationId,
      kind: details.kind,
      ...(details.title ? { title: details.title } : {}),
      lastMessageId: details.lastMessageId,
    });
    const context: InboundContext = {
      account,
      details,
      authorization,
      replyToMessageId: details.lastMessageId,
    };
    const text = normalizeBotCommandText(input.text);
    if (input.stale) {
      if (authorization.allowed) {
        await this.reply(
          context,
          input,
          "这条消息在电脑离线期间到达且已超过允许处理的时间，为避免旧指令重复执行已忽略。请重新发送。",
          "stale",
        );
      }
      return true;
    }

    if (text.toLowerCase().startsWith("/bind")) {
      // Never answer /bind in a group that is not allowlisted.
      if (details.kind === "group" && !authorization.allowed) return true;
      await this.handleBind(context, input, text);
      return true;
    }
    if (!authorization.allowed) {
      if (input.platformUserId && details.kind === "p2p") {
        await this.reply(
          context,
          input,
          "你尚未绑定本机 Agent-in-Box。请在桌面设置中生成一次性绑定码，然后发送 /bind <绑定码>。",
          "unbound",
        );
      }
      return true;
    }
    if (!authorization.identity.bound) return true;

    if (text.startsWith("/")) {
      await this.handleCommand(context, input, text);
      return true;
    }
    await this.handleNaturalLanguage(context, input, text);
    return true;
  }

  private async handleBind(
    context: InboundContext,
    input: BotInboundInput,
    text: string,
  ): Promise<void> {
    if (context.details.kind !== "p2p") {
      await this.reply(context, input, "绑定码只能在机器人单聊中使用。", "bind-group");
      return;
    }
    if (context.authorization.identity.bound) {
      await this.reply(context, input, "你已经绑定到本机。", "bind-already");
      return;
    }
    const code = text.slice("/bind".length).trim();
    if (!code) {
      await this.reply(context, input, "用法：/bind <一次性绑定码>", "bind-usage");
      return;
    }
    try {
      const identity = await this.identities.bindWithCode({
        platform: input.platform,
        platformUserId: input.platformUserId,
        ...(context.details.title ? { displayName: context.details.title } : {}),
        code,
      });
      await this.reply(
        context,
        input,
        `绑定成功。你现在的权限是${identity.role === "admin" ? "管理员" : "只读成员"}。发送 /help 查看可用指令。`,
        "bind-ok",
      );
    } catch (error) {
      await this.reply(context, input, `绑定失败：${errorMessage(error)}`, "bind-failed");
    }
  }

  private async handleCommand(
    context: InboundContext,
    input: BotInboundInput,
    text: string,
  ): Promise<void> {
    const [commandRaw, ...args] = text.split(/\s+/);
    const command = (commandRaw ?? "").toLowerCase();
    const admin = context.authorization.identity.role === "admin";
    switch (command) {
      case "/help":
      case "/帮助":
        await this.reply(context, input, helpText(admin), "help");
        return;
      case "/whoami":
        await this.reply(context, input, identityText(context.authorization.identity), "whoami");
        return;
      case "/status":
        await this.reply(context, input, await this.statusText(), "status");
        return;
      case "/projects":
        await this.reply(context, input, await this.projectsText(), "projects");
        return;
      case "/tasks":
        await this.reply(context, input, await this.tasksText(args[0]), "tasks");
        return;
      case "/task":
        await this.reply(context, input, await this.taskText(args[0]), "task");
        return;
      case "/cancel":
      case "/retry":
      case "/approve":
      case "/reject":
      case "/abort":
        if (!admin) {
          await this.reply(context, input, "该操作需要管理员权限。", "permission");
          return;
        }
        await this.requestConfirmation(context, input, command.slice(1), args[0]);
        return;
      case "/confirm":
        if (!admin) {
          await this.reply(context, input, "该操作需要管理员权限。", "permission");
          return;
        }
        await this.confirm(context, input, args[0], args[1]);
        return;
      default:
        await this.reply(context, input, `未知指令：${command}\n\n${helpText(admin)}`, "unknown");
    }
  }

  private async requestConfirmation(
    context: InboundContext,
    input: BotInboundInput,
    action: string,
    refId: string | undefined,
  ): Promise<void> {
    const normalizedAction = action === "abort" ? "abort" : action;
    if (!["cancel", "retry", "approve", "reject", "abort"].includes(normalizedAction)) {
      await this.reply(context, input, "不支持的确认操作。", "confirm-unsupported");
      return;
    }
    if (normalizedAction !== "abort" && (!refId || refId.trim().length === 0)) {
      await this.reply(context, input, `用法：/${normalizedAction} <ID>`, "confirm-usage");
      return;
    }
    const target = normalizedAction === "abort" ? "router" : refId!.trim();
    if (normalizedAction !== "abort") {
      const exists = await this.validateTarget(normalizedAction, target);
      if (exists !== null) {
        await this.reply(context, input, exists, "confirm-target-missing");
        return;
      }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS).toISOString();
    await this.db
      .deleteFrom("bot_confirmations")
      .where("platform", "=", input.platform)
      .where("conversation_id", "=", input.conversationId)
      .where("platform_user_id", "=", input.platformUserId)
      .execute();
    await this.db
      .insertInto("bot_confirmations")
      .values({
        id: randomUUID(),
        platform: input.platform,
        conversation_id: input.conversationId,
        platform_user_id: input.platformUserId,
        action: normalizedAction,
        ref_id: target,
        expires_at: expiresAt,
        created_at: now.toISOString(),
      })
      .execute();
    const label =
      normalizedAction === "cancel"
        ? "取消任务"
        : normalizedAction === "retry"
          ? "重试任务"
          : normalizedAction === "approve"
            ? "批准审批"
            : normalizedAction === "reject"
              ? "拒绝审批"
              : "中止 Router 当前回合";
    await this.reply(
      context,
      input,
      `${label}属于敏感操作（目标 ${target}）。请在 2 分钟内回复：/confirm ${normalizedAction} ${target}`,
      `confirm-request:${normalizedAction}:${target}`,
    );
  }

  private async confirm(
    context: InboundContext,
    input: BotInboundInput,
    actionRaw: string | undefined,
    refRaw: string | undefined,
  ): Promise<void> {
    const action = (actionRaw ?? "").toLowerCase();
    const refId = action === "abort" ? "router" : (refRaw ?? "").trim();
    if (!action || !refId) {
      await this.reply(context, input, "用法：/confirm <action> <ID>", "confirm-missing");
      return;
    }
    const now = nowIso();
    const confirmation = await this.db
      .selectFrom("bot_confirmations")
      .selectAll()
      .where("platform", "=", input.platform)
      .where("conversation_id", "=", input.conversationId)
      .where("platform_user_id", "=", input.platformUserId)
      .where("action", "=", action)
      .where("ref_id", "=", refId)
      .executeTakeFirst();
    if (!confirmation || confirmation.expires_at <= now) {
      await this.reply(context, input, "确认已过期或不存在，请重新发起操作。", "confirm-expired");
      return;
    }
    await this.db.deleteFrom("bot_confirmations").where("id", "=", confirmation.id).execute();
    try {
      if (action === "cancel") {
        const task = await this.tasks.cancel(
          refId,
          `bot:${input.platform}:${input.platformUserId}`,
        );
        await this.reply(context, input, `任务 ${task.id} 已取消。`, `cancel:${refId}`);
      } else if (action === "retry") {
        const task = await this.tasks.retry(refId);
        await this.reply(
          context,
          input,
          `任务 ${task.id} 已重新排队，当前状态：${taskStatusLabel(task.status)}。`,
          `retry:${refId}`,
        );
      } else if (action === "approve" || action === "reject") {
        const approval = await this.approvals.resolve(
          refId,
          action === "approve" ? "approved" : "rejected",
          `bot:${input.platform}:${input.platformUserId}`,
          "通过机器人确认",
        );
        await this.reply(
          context,
          input,
          `审批 ${approval.id} 已${action === "approve" ? "批准" : "拒绝"}。`,
          `approval:${action}:${refId}`,
        );
      } else if (action === "abort") {
        await this.router.abort();
        await this.reply(context, input, "已请求中止 Router 当前回合。", "abort-router");
      } else {
        await this.reply(context, input, "不支持的确认操作。", "confirm-unsupported");
      }
    } catch (error) {
      await this.reply(
        context,
        input,
        `操作失败：${errorMessage(error)}`,
        `confirm-error:${action}:${refId}`,
      );
    }
  }

  private async handleNaturalLanguage(
    context: InboundContext,
    input: BotInboundInput,
    text: string,
  ): Promise<void> {
    if (!text) return;
    if (context.authorization.identity.role !== "admin") {
      await this.reply(
        context,
        input,
        "只读成员不能发起新任务。请联系管理员或使用查询指令。",
        "readonly",
      );
      return;
    }
    if (text.length > MAX_ROUTER_TEXT) {
      await this.reply(context, input, "消息过长，请缩短后重试。", "too-long");
      return;
    }
    const view = await this.router.view();
    if (view.status === "running") {
      await this.reply(
        context,
        input,
        "Router 正在处理上一条消息。请稍后再试，或由管理员发送 /abort 并确认。",
        "router-busy",
      );
      return;
    }
    const turnId = randomUUID();
    const now = nowIso();
    await this.db
      .insertInto("bot_turns")
      .values({
        id: turnId,
        account_id: input.accountId,
        platform: input.platform,
        platform_conversation_id: input.conversationId,
        local_conversation_id: view.conversationId,
        user_text: text,
        status: "running",
        assistant_text: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .execute();
    const routedText = routerText(context, text);
    try {
      await this.router.send(routedText);
      await this.reply(
        context,
        input,
        "已收到，Router 正在处理。任务状态和结果会自动发送到这里。",
        "accepted",
      );
    } catch (error) {
      const message = errorMessage(error);
      await this.db
        .updateTable("bot_turns")
        .set({
          status: "failed",
          error_message: message.slice(0, 1000),
          updated_at: nowIso(),
          completed_at: nowIso(),
        })
        .where("id", "=", turnId)
        .execute();
      await this.reply(context, input, `Router 未能开始处理：${message}`, "router-failed");
    }
  }

  private async validateTarget(action: string, refId: string): Promise<string | null> {
    if (action === "cancel" || action === "retry") {
      const task = await this.tasks.get(refId);
      return task ? null : `任务不存在：${refId}`;
    }
    try {
      const approval = await this.approvals.get(refId);
      if (approval.status !== "pending") {
        return `审批 ${refId} 当前状态为 ${approval.status}，不能再次处理。`;
      }
      return null;
    } catch {
      return `审批不存在：${refId}`;
    }
  }

  private async statusText(): Promise<string> {
    const [router, report, activeTasks, waitingApprovals, projects] = await Promise.all([
      this.router.view(),
      this.resources.report(),
      this.db
        .selectFrom("tasks")
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("status", "in", [
          "queued",
          "running",
          "waiting_approval",
          "waiting_vm",
          "waiting_resources",
        ])
        .executeTakeFirst(),
      this.db
        .selectFrom("cua_approvals")
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("status", "=", "pending")
        .executeTakeFirst(),
      this.db
        .selectFrom("projects")
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .where("archived_at", "is", null)
        .executeTakeFirst(),
    ]);
    return [
      "本机状态：在线（控制平面正在运行）",
      `Router：${router.status === "running" ? "处理中" : router.status === "failed" ? `失败：${router.lastError ?? "未知错误"}` : "空闲"}`,
      `活跃任务：${Number(activeTasks?.count ?? 0)}；待审批：${Number(waitingApprovals?.count ?? 0)}`,
      `项目：${Number(projects?.count ?? 0)}；运行中 VM：${report.runningVmCount}/${report.totalVmCount}`,
      `内存压力：${report.pressure}；可分配预算：${formatBytes(report.remainingBudgetBytes)}`,
    ].join("\n");
  }

  private async projectsText(): Promise<string> {
    const projects = await this.projects.list(false);
    if (projects.length === 0) return "当前没有可用项目。请先在 Web 界面创建项目并绑定 VM。";
    return projects
      .map((view, index) => {
        const bindings = view.bindings
          .map(
            (binding) =>
              `${binding.vm.name}[${binding.vm.osFamily === "windows" ? "Windows" : "Linux"}](${binding.binding.guestWorkspacePath})`,
          )
          .join("、");
        return `${index + 1}. ${view.project.name} — ${view.project.id}\n   绑定：${bindings || "无"}`;
      })
      .join("\n");
  }

  private async tasksText(statusFilter?: string): Promise<string> {
    const statuses = statusFilter
      ? statusFilter
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const allowed = [
      "created",
      "waiting_resources",
      "waiting_vm",
      "queued",
      "running",
      "waiting_approval",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ];
    const invalid = statuses.find((value) => !allowed.includes(value));
    if (invalid) return `未知任务状态：${invalid}`;
    const page = await this.tasks.list(
      { cursor: null, limit: 10 },
      statuses.length > 0 ? { statuses: statuses as TaskRecord["status"][] } : {},
    );
    if (page.items.length === 0) return "没有匹配的任务。";
    return page.items
      .map(
        (task) =>
          `${taskStatusLabel(task.status)} · ${task.id}\n   ${truncate(task.objective, 120)}`,
      )
      .join("\n");
  }

  private async taskText(taskId?: string): Promise<string> {
    if (!taskId) return "用法：/task <任务 ID>";
    const task = await this.tasks.get(taskId);
    if (!task) return `任务不存在：${taskId}`;
    return [
      `任务 ${task.id}`,
      `状态：${taskStatusLabel(task.status)}`,
      `目标：${truncate(task.objective, 500)}`,
      `摘要：${truncate(task.latestSummary ?? "—", 500)}`,
      ...(task.errorMessage ? [`错误：${truncate(task.errorMessage, 300)}`] : []),
      `更新：${task.updatedAt}`,
    ].join("\n");
  }

  private async reply(
    context: InboundContext,
    input: BotInboundInput,
    text: string,
    tag: string,
  ): Promise<void> {
    await this.outbound.enqueue({
      accountId: input.accountId,
      platform: input.platform,
      conversationId: input.conversationId,
      text,
      kind: "reply",
      refId: input.eventId,
      dedupeKey: `reply:${input.dedupKey}:${tag}`,
      replyToMessageId: context.replyToMessageId,
    });
  }
}

function inboundDetails(
  platform: BotPlatform,
  raw: unknown,
  botUserId: string | undefined,
): { kind: "p2p" | "group"; title: string; lastMessageId: string | null; mentioned: boolean } {
  if (platform === "feishu") {
    const root = asRecord(raw);
    const event = asRecord(root.event);
    const message = asRecord(event.message ?? root.message);
    const chatType = stringValue(message.chat_type);
    const kind = chatType === "group" ? "group" : "p2p";
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const mentioned = mentions.some((mention) => {
      const item = asRecord(mention);
      const id = asRecord(item.id);
      const openId = stringValue(id.open_id);
      return botUserId ? openId === botUserId : Boolean(openId);
    });
    return {
      kind,
      title: stringValue(message.chat_id) ?? "",
      lastMessageId: stringValue(message.message_id) ?? null,
      mentioned: kind === "p2p" || mentioned,
    };
  }
  const root = asRecord(raw);
  const data = asRecord(root.d);
  const groupOpenId = stringValue(data.group_openid);
  return {
    kind: groupOpenId ? "group" : "p2p",
    title: groupOpenId ?? "",
    lastMessageId: stringValue(data.id) ?? null,
    mentioned: groupOpenId ? stringValue(root.t) === "GROUP_AT_MESSAGE_CREATE" : true,
  };
}

function routerText(context: InboundContext, userText: string): string {
  const lines = [
    context.details.kind === "group" ? "机器人入口：群聊" : "机器人入口：单聊",
    `平台：${platformLabel(context.account.platform)}`,
  ];
  if (context.authorization.chat.projectId) {
    lines.push(`本会话默认项目：${context.authorization.chat.projectId}`);
  }
  return `${userText}\n\n[${lines.join("；")}]`;
}

function helpText(admin: boolean): string {
  const common = [
    "/help — 查看帮助",
    "/status — 本机、Router、任务与资源状态",
    "/projects — 列出项目和绑定 VM",
    "/tasks [状态] — 最近任务",
    "/task <ID> — 任务详情",
    "/whoami — 查看平台身份与权限",
  ];
  const adminOnly = [
    "/cancel <任务ID> — 取消任务（需确认）",
    "/retry <任务ID> — 重试任务（需确认）",
    "/approve <审批ID> — 批准审批（需确认）",
    "/reject <审批ID> — 拒绝审批（需确认）",
    "/abort — 中止 Router 当前回合（需确认）",
  ];
  return [
    "直接发送文字即可创建或继续任务。",
    ...common,
    ...(admin ? adminOnly : ["只读成员可使用查询指令，敏感操作仅限管理员。"]),
  ].join("\n");
}

function identityText(identity: BotIdentityRecord): string {
  return [
    `平台用户：${identity.platformUserId}`,
    `显示名称：${identity.displayName || "—"}`,
    `权限：${identity.role === "admin" ? "管理员" : "只读成员"}`,
    `绑定：${identity.bound ? "已绑定" : "未绑定"}`,
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${Math.round(gib * 10) / 10} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function errorMessage(error: unknown): string {
  if (error instanceof PersistenceError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
