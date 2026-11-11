import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotAccountRecord, ResourceReport, RouterView } from "@agent-in-box/protocol";
import type {
  BotConnector,
  BotConnectorStatus,
  InboundBotMessage,
  OutboundBotMessage,
} from "@agent-in-box/bot-connector";
import { ApprovalService } from "../computer-use/approval.service";
import { nowIso } from "../persistence/time";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { ProjectService } from "../projects/project.service";
import { SettingsService } from "../settings/settings.service";
import type { ResourceManagerService } from "../resources/resource-manager.service";
import type { RouterRuntimeService } from "../router/router-runtime.service";
import { BotAccountService } from "./bot-account.service";
import { BotCommandService } from "./bot-command.service";
import { BotConnectorService, type BotConnectorFactoryInput } from "./bot-connector.service";
import { BotIdentityService } from "./bot-identity.service";
import { BotIngressDispatcherService } from "./bot-ingress.service";
import { createBotIngressStore } from "./bot-ingress-store";
import { BotNotificationService } from "./bot-notification.service";
import { BotOutboundService } from "./bot-outbound.service";

class FakeConnector implements BotConnector {
  readonly platform: "qq" | "feishu";
  readonly sent: OutboundBotMessage[] = [];
  readonly admitted: Array<{ key: string; message: InboundBotMessage }> = [];
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  lastError: string | null = null;

  constructor(platform: "qq" | "feishu" = "qq") {
    this.platform = platform;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  getStatus(): BotConnectorStatus {
    return {
      platform: this.platform,
      state: this.connected ? "connected" : "disconnected",
      lastConnectedAt: this.connected ? nowIso() : null,
      lastError: this.lastError,
    };
  }

  async send(message: OutboundBotMessage): Promise<void> {
    this.sent.push(message);
  }

  onMessage(): () => void {
    return () => undefined;
  }

  drainIngress(): InboundBotMessage[] {
    return [];
  }
}

interface Harness {
  ctx: TestContext;
  outbox: OutboxRepository;
  settings: SettingsService;
  tasks: TaskService;
  accounts: BotAccountService;
  identities: BotIdentityService;
  outbound: BotOutboundService;
  notifications: BotNotificationService;
  ingress: BotIngressDispatcherService;
  commands: BotCommandService;
  account: BotAccountRecord;
  routerSent: string[];
  routerStatus: { value: RouterView["status"] };
}

let ctx: TestContext;
let harness: Harness | null = null;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await harness?.ingress.onModuleDestroy();
  await harness?.notifications.onModuleDestroy();
  await harness?.outbound.onModuleDestroy();
  harness = null;
  await ctx.close();
});

async function createHarness(options: { bindUser?: string } = {}): Promise<Harness> {
  const outbox = new OutboxRepository(ctx.app.db);
  const settings = new SettingsService(ctx.app.db);
  const tasks = new TaskService(ctx.app.db, new TaskRepository(ctx.app.db), outbox);
  const accounts = new BotAccountService(ctx.app.db, settings, outbox);
  const account = await accounts.create({
    platform: "qq",
    name: "Test QQ bot",
    appId: "1020304050",
    credentialProviderId: "bot-test-secret",
    enabled: true,
  });
  await accounts.setActiveDevice(true);
  const identities = new BotIdentityService(ctx.app.db, outbox);
  if (options.bindUser) {
    await identities.upsertIdentity("qq", {
      platformUserId: options.bindUser,
      displayName: "Bound admin",
      role: "admin",
      bound: true,
    });
  }
  const connectors = {
    getConnected: () => null,
  } as unknown as BotConnectorService;
  const outbound = new BotOutboundService(ctx.app.db, connectors, outbox, {
    autoTick: false,
  });
  const routerSent: string[] = [];
  const routerStatus: { value: RouterView["status"] } = { value: "idle" };
  const router = {
    view: async (): Promise<RouterView> => ({
      conversationId: ctx.conversationId,
      status: routerStatus.value,
      providerId: "mock",
      modelId: "mock",
      engineVersion: "test",
      sessionVersion: "1",
      lastError: null,
      lastActiveAt: nowIso(),
      tools: [],
      messageCount: 0,
    }),
    send: async (text: string) => {
      routerSent.push(text);
      routerStatus.value = "running";
      return { conversationId: ctx.conversationId, status: "running" as const, message: {} };
    },
    abort: async (): Promise<RouterView> => {
      routerStatus.value = "idle";
      return {
        conversationId: ctx.conversationId,
        status: "idle",
        providerId: null,
        modelId: null,
        engineVersion: null,
        sessionVersion: null,
        lastError: null,
        lastActiveAt: nowIso(),
        tools: [],
        messageCount: 0,
      };
    },
  } as unknown as RouterRuntimeService;
  const report: ResourceReport = {
    capturedAt: nowIso(),
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 8 * 1024 ** 3,
    hostReserveBytes: 2 * 1024 ** 3,
    softMemoryBudgetBytes: 0,
    effectiveBudgetBytes: 14 * 1024 ** 3,
    allocatedMemoryBytes: 0,
    remainingBudgetBytes: 14 * 1024 ** 3,
    pressure: "ok",
    runningVmCount: 0,
    suspendedVmCount: 0,
    totalVmCount: 1,
    waitingResourceTaskCount: 0,
    waitingVmTaskCount: 0,
    queuedTaskCount: 0,
    blockedAutoStarts: [],
    autoStartPolicy: "manual",
    idleSuspendEnabled: false,
    idleSuspendTimeoutMs: 60_000,
    allocations: [],
  };
  const resources = { report: async () => report } as unknown as ResourceManagerService;
  const approvals = new ApprovalService(ctx.app.db, tasks);
  const projects = new ProjectService(ctx.app.db, outbox);
  const commands = new BotCommandService(
    ctx.app.db,
    accounts,
    identities,
    outbound,
    router,
    tasks,
    approvals,
    projects,
    resources,
  );
  const ingress = new BotIngressDispatcherService(ctx.app.db, commands, outbox, {
    autoTick: false,
  });
  const notifications = new BotNotificationService(ctx.app.db, settings, outbound, {
    autoTick: false,
  });
  harness = {
    ctx,
    outbox,
    settings,
    tasks,
    accounts,
    identities,
    outbound,
    notifications,
    ingress,
    commands,
    account,
    routerSent,
    routerStatus,
  };
  return harness;
}

function inboundMessage(input: {
  eventId: string;
  platformUserId: string;
  text: string;
  conversationId?: string;
  group?: boolean;
}): InboundBotMessage {
  return {
    platform: "qq",
    eventId: input.eventId,
    platformUserId: input.platformUserId,
    conversationId: input.conversationId ?? `c2c:${input.platformUserId}`,
    text: input.text,
    receivedAt: nowIso(),
    raw: {
      op: 0,
      t: input.group ? "GROUP_AT_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE",
      d: {
        id: input.eventId,
        content: input.text,
        ...(input.group
          ? {
              group_openid: input.conversationId ?? "group-1",
              author: { member_openid: input.platformUserId },
            }
          : { author: { user_openid: input.platformUserId } }),
      },
    },
  };
}

describe("bot identity and access codes", () => {
  it("binds a platform user once and authorizes p2p messages", async () => {
    const h = await createHarness();
    const before = await h.identities.authorizeInbound({
      platform: "qq",
      platformUserId: "user-1",
      conversationId: "c2c:user-1",
      kind: "p2p",
    });
    expect(before.allowed).toBe(false);
    const code = await h.identities.createAccessCode({ role: "admin" });
    const identity = await h.identities.bindWithCode({
      platform: "qq",
      platformUserId: "user-1",
      code: code.code,
    });
    expect(identity.bound).toBe(true);
    expect(identity.role).toBe("admin");
    const after = await h.identities.authorizeInbound({
      platform: "qq",
      platformUserId: "user-1",
      conversationId: "c2c:user-1",
      kind: "p2p",
    });
    expect(after.allowed).toBe(true);
    await expect(
      h.identities.bindWithCode({ platform: "qq", platformUserId: "user-2", code: code.code }),
    ).rejects.toThrow(/已使用/);
  });

  it("requires an explicit group allowlist", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    const denied = await h.identities.authorizeInbound({
      platform: "qq",
      platformUserId: "user-1",
      conversationId: "group:g-1",
      kind: "group",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("chat_not_allowed");
    await h.identities.upsertChat({
      platform: "qq",
      conversationId: "group:g-1",
      kind: "group",
      allowed: true,
    });
    const allowed = await h.identities.authorizeInbound({
      platform: "qq",
      platformUserId: "user-1",
      conversationId: "group:g-1",
      kind: "group",
    });
    expect(allowed.allowed).toBe(true);
  });
});

describe("durable bot ingress", () => {
  it("persists before ACK and ignores duplicate events", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    const deviceId = await h.accounts.ensureDeviceId();
    const accountStore = createBotIngressStore(ctx.app.db, h.outbox, h.account, deviceId);
    expect(deviceId).toBeTruthy();
    const message = inboundMessage({
      eventId: "event-1",
      platformUserId: "user-1",
      text: "/status",
    });
    expect(await accountStore.admit("qq:device-1:event-1", message)).toBe(true);
    expect(await accountStore.admit("qq:device-1:event-1", message)).toBe(false);
    const rows = await ctx.app.db.selectFrom("bot_events").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("/status");
  });

  it("dispatches a bound user's status command and records the outbound reply", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    const store = createBotIngressStore(ctx.app.db, h.outbox, h.account, "device-1");
    await store.admit(
      "qq:device-1:event-status",
      inboundMessage({ eventId: "event-status", platformUserId: "user-1", text: "/status" }),
    );
    const processed = await h.ingress.processAvailable(10);
    expect(processed).toBe(1);
    const event = await ctx.app.db.selectFrom("bot_events").selectAll().executeTakeFirst();
    expect(event?.state).toBe("processed");
    const outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound.some((row) => row.text.includes("本机状态：在线"))).toBe(true);
  });

  it("denies unbound users without executing commands", async () => {
    const h = await createHarness();
    const store = createBotIngressStore(ctx.app.db, h.outbox, h.account, "device-1");
    await store.admit(
      "qq:device-1:event-denied",
      inboundMessage({ eventId: "event-denied", platformUserId: "stranger", text: "/status" }),
    );
    await h.ingress.processAvailable(10);
    const outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toContain("尚未绑定");
    expect(outbound[0]?.text).not.toContain("本机状态");
  });
});

describe("bot commands and notifications", () => {
  it("sends natural language to the Router, links created tasks and relays status", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    await h.commands.handleInbound({
      accountId: h.account.id,
      platform: "qq",
      eventId: "event-nl",
      dedupKey: "qq:device:event-nl",
      platformUserId: "user-1",
      conversationId: "c2c:user-1",
      text: "请创建一个检查桌面的任务",
      receivedAt: nowIso(),
      raw: inboundMessage({
        eventId: "event-nl",
        platformUserId: "user-1",
        text: "请创建一个检查桌面的任务",
      }).raw,
      stale: false,
    });
    expect(h.routerSent[0]).toContain("请创建一个检查桌面的任务");
    expect(h.routerSent[0]).toContain("机器人入口");
    const turn = await ctx.app.db.selectFrom("bot_turns").selectAll().executeTakeFirst();
    expect(turn?.status).toBe("running");

    await h.notifications.consume();
    const created = await h.tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective: "Bot-created task",
      idempotencyKey: "bot-task-1",
    });
    await h.notifications.consume();
    const link = await ctx.app.db
      .selectFrom("bot_task_links")
      .selectAll()
      .where("task_id", "=", created.task.id)
      .executeTakeFirst();
    expect(link).toBeTruthy();
    let outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound.some((row) => row.text.includes("已创建任务"))).toBe(true);

    await h.tasks.cancel(created.task.id, "test cleanup");
    await h.notifications.consume();
    outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound.some((row) => row.text.includes("已取消"))).toBe(true);
  });

  it("notifies the origin chat about approval requests and local resolutions", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    const created = await h.tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective: "Approval task",
      idempotencyKey: "bot-approval-1",
    });
    const now = nowIso();
    await ctx.app.db
      .insertInto("workers")
      .values({
        id: "bot-worker-1",
        project_id: ctx.projectId,
        vm_id: ctx.vmId,
        conversation_id: ctx.conversationId,
        engine_type: "pi-rpc",
        engine_version: "test",
        status: "running",
        current_task_id: created.task.id,
        capability_set: "[]",
        created_at: now,
        last_active_at: now,
        archived_at: null,
        agent_session_ref: null,
        session_version: null,
        last_heartbeat_at: null,
        archive_summary: null,
        last_error_code: null,
        last_error_message: null,
        broker_token_id: null,
        provider_id: null,
        model_id: null,
      })
      .execute();
    await ctx.app.db
      .insertInto("cua_actions")
      .values({
        id: "bot-action-1",
        task_id: created.task.id,
        worker_id: "bot-worker-1",
        vm_id: ctx.vmId,
        lease_id: "bot-lease-1",
        action_type: "click",
        action_json: "{}",
        source_screenshot_id: null,
        before_screenshot_id: null,
        after_screenshot_id: null,
        display_json: "{}",
        status: "pending",
        result_json: null,
        error_code: null,
        error_message: null,
        approval_id: null,
        created_at: now,
        executed_at: null,
        duration_ms: null,
      })
      .execute();
    await ctx.app.db
      .insertInto("cua_approvals")
      .values({
        id: "bot-approval-1",
        task_id: created.task.id,
        worker_id: "bot-worker-1",
        action_id: "bot-action-1",
        action_type: "click",
        action_json: "{}",
        context_summary: "点击下载按钮",
        status: "pending",
        requested_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      })
      .execute();
    await ctx.app.db
      .insertInto("bot_turns")
      .values({
        id: "bot-turn-approval",
        account_id: h.account.id,
        platform: "qq",
        platform_conversation_id: "c2c:user-1",
        local_conversation_id: ctx.conversationId,
        user_text: "do it",
        status: "completed",
        assistant_text: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        completed_at: now,
      })
      .execute();
    await ctx.app.db
      .insertInto("bot_task_links")
      .values({
        task_id: created.task.id,
        turn_id: "bot-turn-approval",
        account_id: h.account.id,
        platform: "qq",
        platform_conversation_id: "c2c:user-1",
        created_at: now,
      })
      .execute();
    await h.notifications.consume();
    await h.tasks.recordWorkerEvent(created.task.id, "task.approval_requested", {
      taskId: created.task.id,
      approvalId: "bot-approval-1",
      actionId: "bot-action-1",
      actionType: "click",
      summary: "点击下载按钮",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.notifications.consume();
    let outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound.some((row) => row.text.includes("需要审批"))).toBe(true);
    expect(outbound.some((row) => row.text.includes("/approve bot-approval-1"))).toBe(true);
    const link = await ctx.app.db
      .selectFrom("bot_approval_links")
      .selectAll()
      .where("approval_id", "=", "bot-approval-1")
      .executeTakeFirst();
    expect(link).toBeTruthy();

    const approvals = new ApprovalService(ctx.app.db, h.tasks);
    await approvals.resolve("bot-approval-1", "approved", "local-user");
    await h.notifications.consume();
    outbound = await ctx.app.db.selectFrom("bot_outbound").selectAll().execute();
    expect(outbound.some((row) => row.text.includes("已批准"))).toBe(true);
  });

  it("requires an explicit confirmation before cancelling a task", async () => {
    const h = await createHarness({ bindUser: "user-1" });
    const created = await h.tasks.create({
      projectId: ctx.projectId,
      vmId: ctx.vmId,
      originConversationId: ctx.conversationId,
      objective: "Cancel me",
      idempotencyKey: "bot-cancel-1",
    });
    const base = {
      accountId: h.account.id,
      platform: "qq" as const,
      platformUserId: "user-1",
      conversationId: "c2c:user-1",
      receivedAt: nowIso(),
      raw: inboundMessage({
        eventId: "event-cancel",
        platformUserId: "user-1",
        text: `/cancel ${created.task.id}`,
      }).raw,
      stale: false,
    };
    await h.commands.handleInbound({
      ...base,
      eventId: "event-cancel",
      dedupKey: "qq:device:event-cancel",
      text: `/cancel ${created.task.id}`,
    });
    let task = await h.tasks.get(created.task.id);
    expect(task?.status).not.toBe("cancelled");
    const prompt = await ctx.app.db
      .selectFrom("bot_outbound")
      .selectAll()
      .where("kind", "=", "reply")
      .execute();
    expect(prompt.some((row) => row.text.includes("/confirm cancel"))).toBe(true);

    await h.commands.handleInbound({
      ...base,
      eventId: "event-confirm",
      dedupKey: "qq:device:event-confirm",
      text: `/confirm cancel ${created.task.id}`,
    });
    task = await h.tasks.get(created.task.id);
    expect(task?.status).toBe("cancelled");
  });
});

describe("bot connector supervision", () => {
  it("starts enabled accounts on the active device, persists state and sends outbound", async () => {
    const outbox = new OutboxRepository(ctx.app.db);
    const settings = new SettingsService(ctx.app.db);
    const accounts = new BotAccountService(ctx.app.db, settings, outbox);
    const account = await accounts.create({
      platform: "qq",
      name: "QQ bot",
      appId: "100200300",
      credentialProviderId: "bot-supervisor-secret",
      enabled: true,
    });
    await accounts.setActiveDevice(true);
    const created: FakeConnector[] = [];
    const factoryInputs: BotConnectorFactoryInput[] = [];
    const service = new BotConnectorService(
      ctx.app.db,
      accounts,
      outbox,
      { getSecret: async () => "bot-secret-value" },
      {
        autoTick: false,
        connectorFactory: (input) => {
          factoryInputs.push(input);
          const connector = new FakeConnector("qq");
          created.push(connector);
          return connector;
        },
      },
    );
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(1);
    expect(factoryInputs[0]?.account.id).toBe(account.id);
    expect(service.getConnected(account.id)).not.toBeNull();
    expect((await accounts.get(account.id)).state).toBe("connected");
    const store = factoryInputs[0]!.ingressStore;
    expect(
      await store.admit(
        "qq:device:event-supervised",
        inboundMessage({ eventId: "event-supervised", platformUserId: "user-1", text: "hi" }),
      ),
    ).toBe(true);

    const outbound = new BotOutboundService(ctx.app.db, service, outbox, { autoTick: false });
    await outbound.enqueue({
      accountId: account.id,
      platform: "qq",
      conversationId: "c2c:user-1",
      text: "hello",
      kind: "test",
      dedupeKey: "test:supervised",
    });
    expect(await outbound.flush()).toBe(1);
    expect(created[0]!.sent[0]?.text).toBe("hello");

    await accounts.update(account.id, { enabled: false });
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.getConnector(account.id)).toBeNull();
  });
});
