import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkerEngineEvent,
  WorkerSessionHandle,
  WorkerSessionSpec,
} from "@agent-in-box/agent-runtime";
import type { SupervisorVmState } from "@agent-in-box/protocol";
import { ModelProviderService } from "../models/model-provider.service";
import { ModelTokenService } from "../models/model-token.service";
import type { ModelBrokerService } from "../models/model-broker.service";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import type { SupervisorClient } from "../vms/supervisor.client";
import { WorkerRuntimeService, type WorkerGuestConnection } from "./worker-runtime.service";

class FakeConnection implements WorkerGuestConnection {
  readonly prompts: string[] = [];
  readonly specs: WorkerSessionSpec[] = [];
  subscribedSessionId: string | null = null;
  abortCalls = 0;
  archiveCalls = 0;
  resumeCalls: string[] = [];
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
    return {
      sessionId: "resumed-session",
      archiveRef: "/guest/sessions/resumed-session.jsonl",
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
      mode: "native",
    };
  }

  async prompt(_sessionId: string, input: { text: string }): Promise<void> {
    this.prompts.push(input.text);
    this.hold = input.text.includes("[hold]");
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
}

async function createHarness(
  options: { connection?: FakeConnection; ctx?: TestContext } = {},
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
  const service = new WorkerRuntimeService(
    ctx.app.db,
    workers,
    new OutboxRepository(ctx.app.db),
    tasks,
    leases,
    leaseRepository,
    supervisor,
    providers,
    tokens,
    broker,
    {
      connectorFactory: () => connection,
      tickIntervalMs: 300,
      heartbeatIntervalMs: 5000,
    },
  );
  await service.onModuleInit();
  return { ctx, service, tasks, leases, workers, tokens, connection, storageRoot };
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

    const restarted = await createHarness({ connection: harness.connection, ctx: harness.ctx });
    active = restarted;
    const resumed = await restarted.service.resume(created.worker.id);
    expect(resumed.runtime.connected).toBe(true);
    expect(restarted.connection.resumeCalls).toEqual(["/guest/sessions/fake-session.jsonl"]);
    expect(resumed.worker.status).toBe("idle");

    const task = await harness.tasks.get(prompted.taskId);
    expect(task).toMatchObject({ status: "failed", errorCode: "worker_runtime_restarted" });
    const worker = await harness.workers.getWorker(created.worker.id);
    expect(worker?.agentSessionRef).toContain("resumed-session");
  });
});
