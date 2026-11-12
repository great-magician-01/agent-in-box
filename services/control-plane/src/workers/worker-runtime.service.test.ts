import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkerEngineEvent,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type { SupervisorVmState } from "@agent-in-box/protocol";
import type { ModelBrokerService } from "../models/model-broker.service";
import { ModelProviderService } from "../models/model-provider.service";
import { ModelTokenService } from "../models/model-token.service";
import { ApprovalService } from "../computer-use/approval.service";
import type { CuaBrokerService } from "../computer-use/cua-broker.service";
import { CuaExecutionService } from "../computer-use/cua-execution.service";
import { CuaPolicyService } from "../computer-use/cua-policy.service";
import { CuaTokenService } from "../computer-use/cua-token.service";
import { SettingsService } from "../settings/settings.service";
import type { GuestService } from "../vms/guest.service";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerArchiveRepository } from "../persistence/repositories/worker-archive-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import type { DatabaseService } from "../persistence/database.service";
import type { SupervisorClient } from "../vms/supervisor.client";
import { WorkerRegistryService } from "./worker-registry.service";
import { WorkerRuntimeService, type WorkerGuestConnection } from "./worker-runtime.service";

class FakeConnection implements WorkerGuestConnection {
  readonly prompts: string[] = [];
  readonly promptImages: Array<WorkerInput["images"]> = [];
  readonly specs: WorkerSessionSpec[] = [];
  subscribedSessionId: string | null = null;
  abortCalls = 0;
  archiveCalls = 0;
  startSessionCalls = 0;
  resumeCalls: string[] = [];
  resumeError: Error | null = null;
  private listener: ((event: WorkerEngineEvent) => void) | null = null;
  private hold = false;

  constructor(
    readonly sessionId = "fake-session",
    readonly engineVersion = "1.5.1",
    readonly sessionVersion = "1",
  ) {}

  async handshake() {
    return {
      protocolVersion: "0.1.0",
      engineType: "pi-rpc",
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
      compatible: true,
    };
  }

  async startSession(spec: WorkerSessionSpec): Promise<WorkerSessionHandle> {
    this.startSessionCalls += 1;
    this.specs.push(spec);
    return {
      sessionId: this.sessionId,
      archiveRef: `/guest/sessions/${this.sessionId}.jsonl`,
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
    };
  }

  async resume(archiveRef: string, spec: WorkerSessionSpec) {
    this.resumeCalls.push(archiveRef);
    this.specs.push(spec);
    if (this.resumeError) throw this.resumeError;
    return {
      sessionId: "resumed-session",
      archiveRef: "/guest/sessions/resumed-session.jsonl",
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
      mode: "native" as const,
    };
  }

  async prompt(_sessionId: string, input: WorkerInput) {
    this.prompts.push(input.text);
    this.promptImages.push(input.images);
    this.hold = input.text.startsWith("[hold]");
    this.emit({ type: "text_delta", delta: "working" });
    this.emit({ type: "tool_started", toolName: "vm_screenshot", input: {} });
    if (!this.hold) {
      this.emit({ type: "tool_finished", toolName: "vm_screenshot", output: {}, isError: false });
      setTimeout(() => this.emit({ type: "turn_finished" }), 10);
    }
  }

  async steer(): Promise<"queued" | "handled"> {
    return "queued";
  }

  async followUp(): Promise<"queued" | "handled"> {
    return "queued";
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.emit({ type: "tool_finished", toolName: "vm_screenshot", output: {}, isError: true });
    this.emit({ type: "turn_finished" });
  }

  async archive() {
    this.archiveCalls += 1;
    return { archiveRef: "/guest/backups/fake.jsonl", summary: "archived" };
  }

  async session(): Promise<unknown> {
    return { status: "active" };
  }

  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void {
    this.subscribedSessionId = sessionId;
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: WorkerEngineEvent): void {
    this.listener?.(event);
  }
}

interface Harness {
  ctx: TestContext;
  service: WorkerRuntimeService;
  tasks: TaskService;
  leases: LeaseService;
  workers: WorkerRepository;
  tokens: ModelTokenService;
  connection: FakeConnection;
  storageRoot: string;
  archives: WorkerArchiveRepository;
  registry: WorkerRegistryService;
  outbox: OutboxRepository;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BGDs0ABwABf/9WlFTKAAAAAElFTkSuQmCC",
  "base64",
);

async function createHarness(
  options: {
    connection?: FakeConnection;
    ctx?: TestContext;
    lifecyclePolicy?: { autoArchiveEnabled: boolean; idleTimeoutMs: number };
    heartbeatIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const ctx = options.ctx ?? (await createTestContext());
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy" })
    .where("id", "=", ctx.vmId)
    .execute();
  const storageRoot = ctx.dir;
  const connection = options.connection ?? new FakeConnection();
  const tasks = new TaskService(
    ctx.app.db,
    new TaskRepository(ctx.app.db),
    new OutboxRepository(ctx.app.db),
    { artifactRoot: path.join(ctx.dir, "artifacts") },
  );
  const leaseRepository = new LeaseRepository(ctx.app.db);
  const leases = new LeaseService(ctx.app.db, leaseRepository);
  const workers = new WorkerRepository(ctx.app.db);
  const providers = new ModelProviderService(ctx.app.db);
  await providers.upsert("mock", {
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    credentialProviderId: "mock",
    models: [{ id: "mock-cua", name: "Mock CUA" }],
    enabled: true,
  });
  const tokens = new ModelTokenService(ctx.app.db, { ttlMs: 60_000 });
  const supervisor = {
    get: async (id: string): Promise<SupervisorVmState> =>
      ({
        id,
        powerState: "running",
        workerHostPort: 19000,
        guestHostPort: 18000,
      }) as unknown as SupervisorVmState,
  } as unknown as SupervisorClient;
  const broker = { port: 6719 } as unknown as ModelBrokerService;
  const settings = new SettingsService(ctx.app.db);
  const policies = new CuaPolicyService(ctx.app.db, settings);
  const approvals = new ApprovalService(ctx.app.db, tasks);
  const cuaTokens = new CuaTokenService(ctx.app.db, { ttlMs: 60_000 });
  const cuaGuest = {
    observe: async () => {
      throw new Error("unexpected Guest observation in Worker runtime test");
    },
    desktop: async () => {
      throw new Error("unexpected Guest desktop call in Worker runtime test");
    },
  } as unknown as GuestService;
  const cua = new CuaExecutionService(
    ctx.app.db,
    cuaGuest,
    tasks,
    leaseRepository,
    policies,
    approvals,
  );
  const cuaBroker = {
    guestBaseUrl: () => "http://10.0.2.2:6720",
  } as CuaBrokerService;
  const outbox = new OutboxRepository(ctx.app.db);
  const archives = new WorkerArchiveRepository(ctx.app.db);
  const registry = new WorkerRegistryService(ctx.app.db, workers, archives, tasks, outbox);
  const guest = {
    observe: async () => ({
      desktop: { width: 64, height: 48, dpi: 96, scaleFactor: 1 },
      screenshot: {
        actionId: "resume-shot",
        width: 64,
        height: 48,
        capturedAt: new Date().toISOString(),
        dataBase64: PNG.toString("base64"),
      },
    }),
    desktop: async () => {
      throw new Error("unexpected Guest desktop call in Worker runtime test");
    },
  } as unknown as GuestService;
  const database = {
    layout: { archives: path.join(ctx.dir, "archives") },
  } as DatabaseService;
  const service = new WorkerRuntimeService(
    ctx.app.db,
    workers,
    outbox,
    tasks,
    leases,
    leaseRepository,
    supervisor,
    providers,
    tokens,
    broker,
    cuaTokens,
    cua,
    cuaBroker,
    archives,
    registry,
    guest,
    database,
    settings,
    {
      connectorFactory: () => connection,
      tickIntervalMs: 300,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000,
      idleCheckIntervalMs: 1000,
      workerLifecyclePolicy: options.lifecyclePolicy ?? {
        autoArchiveEnabled: false,
        idleTimeoutMs: 60_000,
      },
      resumeContextRoot: path.join(ctx.dir, "archives", "resume-contexts"),
    },
  );
  await service.onModuleInit();
  return {
    ctx,
    service,
    tasks,
    leases,
    workers,
    tokens,
    connection,
    storageRoot,
    archives,
    registry,
    outbox,
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let active: Harness | null = null;

afterEach(async () => {
  active?.service.onModuleDestroy();
  await active?.ctx.close();
  active = null;
});

describe("WorkerRuntimeService", () => {
  it("creates a Worker, runs a task turn and persists trace, message and blocked status", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    expect(created.runtime.connected).toBe(true);
    expect(created.worker.providerId).toBe("mock");
    expect(created.worker.modelId).toBe("mock-cua");
    expect(harness.connection.specs[0]?.mcpEnabled).toBe(false);

    const prompted = await harness.service.prompt(created.worker.id, {
      text: "Open the file manager",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "blocked",
      "blocked task",
    );
    const task = await harness.tasks.get(prompted.taskId);
    expect(task).toMatchObject({ status: "blocked", errorCode: "awaiting_verification" });
    expect(harness.connection.prompts).toEqual(["Open the file manager"]);

    const detail = await harness.tasks.detail(prompted.taskId);
    expect(detail.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.status_changed",
        "worker.turn_started",
        "worker.tool_started",
        "worker.tool_finished",
        "worker.turn_finished",
      ]),
    );
    const messages = await harness.service.messages(created.worker.id);
    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Open the file manager",
      "assistant:working",
    ]);
    await expect(harness.leases.getActive(harness.ctx.vmId)).resolves.toBeUndefined();
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker).toMatchObject({ status: "idle", currentTaskId: null });
    const tokenRows = await harness.ctx.app.db.selectFrom("model_tokens").selectAll().execute();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({ session_id: "fake-session", task_id: null });
    const cuaRows = await harness.ctx.app.db.selectFrom("cua_tokens").selectAll().execute();
    expect(cuaRows).toHaveLength(1);
    expect(cuaRows[0]).toMatchObject({ session_id: "fake-session", task_id: null });
    expect(harness.connection.specs[0]?.computerUse).toMatchObject({
      baseUrl: "http://10.0.2.2:6720",
    });
    expect(harness.connection.specs[0]?.computerUse?.token).toBeTruthy();
    expect(harness.connection.specs[0]?.computerUse?.token).not.toBe(
      (tokenRows[0] as { token_hash?: string })?.token_hash,
    );
    const execution = await harness.ctx.app.db
      .selectFrom("task_execution_state")
      .selectAll()
      .where("task_id", "=", prompted.taskId)
      .executeTakeFirst();
    expect(execution).toMatchObject({ worker_id: created.worker.id, requires_observation: 1 });
  });

  it("renews the execution lease while tool events keep the RPC heartbeat fresh", async () => {
    // A busy turn emits tool/text events continuously. Those events refresh the
    // RPC heartbeat timestamp, but must not starve the 30s execution lease.
    const harness = await createHarness({ heartbeatIntervalMs: 60_000 });
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, { text: "[hold]" });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    const lease = await harness.leases.getActive(harness.ctx.vmId);
    expect(lease).toBeTruthy();
    const runtime = (
      harness.service as unknown as {
        active: Map<string, { lastHeartbeatAt: number; lastLeaseRenewAt: number }>;
      }
    ).active.get(created.worker.id);
    expect(runtime).toBeTruthy();
    // Simulate continuous events and a renewal that is already due.
    runtime!.lastHeartbeatAt = Date.now();
    runtime!.lastLeaseRenewAt = Date.now() - 11_000;
    await waitFor(async () => {
      const current = await harness.leases.getActive(harness.ctx.vmId);
      return Boolean(current && current.expiresAt > lease!.expiresAt);
    }, "renewed lease");
    await harness.service.abort(created.worker.id, "test cleanup");
  });

  it("steers a running turn, maps Abort to a stopped task and releases the lease", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, {
      text: "[hold] Long desktop task",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    await expect(
      harness.service.steer(created.worker.id, { text: "Use the terminal" }),
    ).resolves.toMatchObject({
      disposition: "queued",
      taskId: prompted.taskId,
    });
    const before = await harness.tasks.detail(prompted.taskId);
    expect(before.events.map((event) => event.type)).toContain("worker.steer");

    const aborted = await harness.service.abort(created.worker.id, "用户中止");
    expect(aborted.worker.status).toBe("idle");
    expect(harness.connection.abortCalls).toBe(1);
    const task = await harness.tasks.get(prompted.taskId);
    expect(task).toMatchObject({ status: "blocked", errorCode: "worker_aborted" });
    await expect(harness.leases.getActive(harness.ctx.vmId)).resolves.toBeUndefined();
    const messages = await harness.service.messages(created.worker.id);
    expect(messages.at(-1)?.content).toBe("working");
  });

  it("maps an externally cancelled task to an RPC Abort without overwriting the cancelled state", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, {
      text: "[hold] Another long task",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    await harness.tasks.cancel(prompted.taskId, "用户取消");
    await waitFor(() => harness.connection.abortCalls === 1, "worker abort");
    const task = await harness.tasks.get(prompted.taskId);
    expect(task?.status).toBe("cancelled");
    await expect(harness.leases.getActive(harness.ctx.vmId)).resolves.toBeUndefined();
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker?.status).toBe("idle");
  });

  it("fails the task and revokes the broker token on RPC disconnect", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, {
      text: "[hold] Disconnect task",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    harness.connection.emit({ type: "session_failed", message: "Pi process crashed" });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "failed",
      "failed task",
    );
    const task = await harness.tasks.get(prompted.taskId);
    expect(task).toMatchObject({ status: "failed", errorCode: "worker_rpc_failed" });
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker).toMatchObject({ status: "failed", lastErrorCode: "worker_rpc_failed" });
    expect(worker?.agentSessionRef).toContain("fake-session");
    const tokenRows = await harness.ctx.app.db
      .selectFrom("model_tokens")
      .selectAll()
      .where("worker_id", "=", created.worker.id)
      .execute();
    expect(tokenRows.every((row) => row.revoked_at !== null)).toBe(true);
    await expect(harness.leases.getActive(harness.ctx.vmId)).resolves.toBeUndefined();
  });

  it("blocks the task instead of replaying actions when the VM stops", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, {
      text: "[hold] VM stop task",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    await harness.ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "stopped" })
      .where("id", "=", harness.ctx.vmId)
      .execute();
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "blocked",
      "blocked task",
    );
    expect((await harness.tasks.get(prompted.taskId))?.errorCode).toBe("worker_vm_stopped");
    expect((await harness.workers.getWorker(created.worker.id))?.status).toBe("failed");
    await expect(harness.leases.getActive(harness.ctx.vmId)).resolves.toBeUndefined();
    await harness.ctx.app.db
      .updateTable("vm_instances")
      .set({ power_state: "running" })
      .where("id", "=", harness.ctx.vmId)
      .execute();
    const requeued = await harness.tasks.requeue(prompted.taskId);
    expect(requeued.status).toBe("queued");
  });

  it("reconciles a control-plane restart without losing the Worker binding and can resume", async () => {
    const harness = await createHarness();
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const prompted = await harness.service.prompt(created.worker.id, {
      text: "[hold] Restart task",
    });
    await waitFor(
      async () => (await harness.tasks.get(prompted.taskId))?.status === "running",
      "running task",
    );
    harness.service.onModuleDestroy();

    await harness.ctx.app.db
      .updateTable("projects")
      .set({ agent_config_json: JSON.stringify({ mcpEnabled: true }) })
      .where("id", "=", harness.ctx.projectId)
      .execute();
    const restarted = await createHarness({ connection: harness.connection, ctx: harness.ctx });
    active = restarted;
    const resumed = await restarted.service.resume(created.worker.id);
    expect(resumed.worker.runtime.connected).toBe(true);
    expect(resumed.restoreMode).toBe("native");
    expect(resumed.context.screenshot?.sha256 ?? "").toHaveLength(64);
    expect(restarted.connection.resumeCalls).toEqual(["/guest/sessions/fake-session.jsonl"]);
    expect(restarted.connection.specs.at(-1)?.mcpEnabled).toBe(true);
    await waitFor(
      async () => (await restarted.service.get(created.worker.id)).worker.status === "idle",
      "resumed worker idle",
    );

    const task = await harness.tasks.get(prompted.taskId);
    expect(task).toMatchObject({ status: "failed", errorCode: "worker_runtime_restarted" });
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker?.agentSessionRef).toContain("resumed-session");
  });

  it("archives an idle Worker into the registry without stopping the VM", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    const archived = await harness.service.archive(created.worker.id);
    expect(archived.worker.status).toBe("archived");
    expect(archived.worker.archivedAt).toBeTruthy();
    expect(harness.connection.archiveCalls).toBe(1);

    const records = await harness.archives.listForWorker(created.worker.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "manual", status: "available" });
    expect(records[0]?.summary).toContain("archived");
    await expect(harness.registry.activeRoster(harness.ctx.projectId)).resolves.toMatchObject({
      workers: [],
    });
    const search = await harness.registry.searchArchives({ query: "archived" });
    expect(search.items.map((item) => item.id)).toContain(records[0]?.id);

    const vm = await harness.ctx.app.db
      .selectFrom("vm_instances")
      .select("power_state")
      .where("id", "=", harness.ctx.vmId)
      .executeTakeFirstOrThrow();
    expect(vm.power_state).toBe("running");
    const tokens = await harness.ctx.app.db.selectFrom("model_tokens").selectAll().execute();
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
  });

  it("auto-archives an idle Worker after the configured timeout", async () => {
    const harness = await createHarness({
      lifecyclePolicy: { autoArchiveEnabled: true, idleTimeoutMs: 1 },
    });
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    await waitFor(
      async () => (await harness.workers.getWorker(created.worker.id))?.status === "archived",
      "idle worker auto archive",
    );
    expect(harness.connection.archiveCalls).toBe(1);
    const records = await harness.archives.listForWorker(created.worker.id);
    expect(records[0]).toMatchObject({ source: "auto" });
  }, 10_000);

  it("does not auto-archive a Worker with queued follow-up input", async () => {
    const harness = await createHarness({
      lifecyclePolicy: { autoArchiveEnabled: true, idleTimeoutMs: 1 },
    });
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    await harness.service.followUp(created.worker.id, { text: "do this next" });
    await delay(1800);
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker?.status).toBe("idle");
    expect(harness.connection.archiveCalls).toBe(0);
    const inputs = await harness.ctx.app.db
      .selectFrom("worker_inputs")
      .selectAll()
      .where("worker_id", "=", created.worker.id)
      .execute();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.status).toBe("pending");
  }, 10_000);

  it("falls back to a labelled summary restore when native resume fails", async () => {
    const harness = await createHarness();
    active = harness;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    await harness.service.archive(created.worker.id);
    const catalog = new CatalogRepository(harness.ctx.app.db);
    const other = await catalog.createProject({ name: "Shared VM neighbour" });
    await catalog.bindVm({
      projectId: other.id,
      vmId: harness.ctx.vmId,
      guestWorkspacePath: "/home/worker/neighbour",
      isPrimary: true,
    });
    await harness.ctx.app.db
      .insertInto("project_activities")
      .values({
        project_id: other.id,
        type: "task.status_changed",
        payload_json: "{}",
        created_at: new Date(Date.now() + 5_000).toISOString(),
      })
      .execute();
    harness.connection.resumeError = new Error(
      "Incompatible Worker Engine/Session version 1.5.1/1",
    );
    const startsBefore = harness.connection.startSessionCalls;
    const resumed = await harness.service.resume(created.worker.id, { mode: "auto" });
    expect(resumed.restoreMode).toBe("summary");
    expect(resumed.notice).toContain("原生会话恢复失败");
    expect(resumed.context.environment.sharedVm).toBe(true);
    expect(resumed.context.environment.sharedProjects.map((project) => project.name)).toEqual([
      "Shared VM neighbour",
    ]);
    expect(resumed.context.environment.changesSinceArchive.join("\n")).toContain(
      "Shared VM neighbour",
    );
    expect(harness.connection.startSessionCalls).toBe(startsBefore + 1);
    expect(harness.connection.specs.at(-1)?.systemPrompt).toContain(
      "Archived Worker session summary",
    );
    await waitFor(
      async () => (await harness.service.get(created.worker.id)).worker.status === "idle",
      "summary-restored worker idle",
    );
  }, 10_000);

  it("creates a new Worker from an archive summary with a fresh environment observation", async () => {
    const harness = await createHarness();
    active = harness;
    const source = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
    });
    await harness.service.archive(source.worker.id);
    const archive = (await harness.archives.listForWorker(source.worker.id))[0]!;
    const created = await harness.service.create({
      projectId: harness.ctx.projectId,
      vmId: harness.ctx.vmId,
      restoreArchiveId: archive.id,
    });
    expect(created.worker.id).not.toBe(source.worker.id);
    expect(created.runtime.restoreMode).toBe("summary");
    expect(harness.connection.specs.at(-1)?.systemPrompt).toContain(
      "Archived Worker session summary",
    );
    const contexts = await harness.ctx.app.db
      .selectFrom("worker_resume_contexts")
      .selectAll()
      .where("worker_id", "=", created.worker.id)
      .execute();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ restore_mode: "summary" });
  }, 10_000);
});
