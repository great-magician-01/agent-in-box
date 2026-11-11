import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuestDesktopInfo, GuestScreenshot, GuestVerifyRequest } from "@agent-in-box/protocol";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { WorkerRepository } from "../persistence/repositories/worker-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService } from "../settings/settings.service";
import type { GuestService } from "../vms/guest.service";
import { ApprovalService } from "./approval.service";
import { CuaExecutionService } from "./cua-execution.service";
import { CuaPolicyService } from "./cua-policy.service";
import { CuaTokenService, type CuaTokenContext } from "./cua-token.service";

class FakeGuest {
  display: GuestDesktopInfo = {
    displayServer: "x11",
    width: 1280,
    height: 720,
    dpi: 96,
    scaleFactor: 1,
  };
  screen = Buffer.from("screen-frame-1");
  inputCalls: Array<{ action: unknown; actionId?: string; timeoutMs?: number }> = [];
  verifyCalls: GuestVerifyRequest[] = [];
  verifyOk = true;
  failInput = false;
  advanceScreen = true;

  async observe(): Promise<{ desktop: GuestDesktopInfo; screenshot: GuestScreenshot }> {
    const screenshot: GuestScreenshot = {
      actionId: "guest-shot",
      width: this.display.width,
      height: this.display.height,
      capturedAt: new Date().toISOString(),
      dataBase64: this.screen.toString("base64"),
    };
    return { desktop: { ...this.display }, screenshot };
  }

  async desktop(): Promise<GuestDesktopInfo> {
    return { ...this.display };
  }

  async input(
    _vmId: string,
    request: { action: unknown; actionId?: string; timeoutMs?: number },
  ): Promise<{ actionId: string; ok: boolean; error?: string }> {
    this.inputCalls.push(request);
    if (this.failInput)
      return { actionId: request.actionId ?? "guest", ok: false, error: "fake failure" };
    if (this.advanceScreen) this.screen = Buffer.from(`screen-frame-${this.inputCalls.length + 1}`);
    return { actionId: request.actionId ?? "guest", ok: true };
  }

  async verify(_vmId: string, request: GuestVerifyRequest) {
    this.verifyCalls.push(request);
    return {
      actionId: "verify",
      ok: this.verifyOk,
      checks: request.checks.map((check) => ({
        type: check.type,
        ok: this.verifyOk,
        ...(this.verifyOk ? {} : { errorCode: "fake_failure", error: "fake verify failure" }),
        ...(check.type === "file"
          ? { path: check.path, sizeBytes: 12, sha256: "a".repeat(64) }
          : {}),
        ...(check.type === "process" ? { pids: [123] } : {}),
      })),
    };
  }
}

interface Harness {
  ctx: TestContext;
  tasks: TaskService;
  leases: LeaseService;
  workers: WorkerRepository;
  policies: CuaPolicyService;
  approvals: ApprovalService;
  cua: CuaExecutionService;
  guest: FakeGuest;
  workerId: string;
  taskId: string;
  token: CuaTokenContext;
}

async function createHarness(): Promise<Harness> {
  const ctx = await createTestContext();
  await ctx.app.db
    .updateTable("vm_instances")
    .set({ power_state: "running", guest_health: "healthy" })
    .where("id", "=", ctx.vmId)
    .execute();
  const tasks = new TaskService(
    ctx.app.db,
    new TaskRepository(ctx.app.db),
    new OutboxRepository(ctx.app.db),
    { artifactRoot: path.join(ctx.dir, "artifacts") },
  );
  const leaseRepository = new LeaseRepository(ctx.app.db);
  const leases = new LeaseService(ctx.app.db, leaseRepository);
  const workers = new WorkerRepository(ctx.app.db);
  const worker = await workers.createWorker({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    conversationId: ctx.conversationId,
    engineType: "pi-rpc",
    engineVersion: "1.5.1",
    capabilitySet: ["computer_use"],
  });
  await tasks.create({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    objective: "Type a report into the desktop editor",
    idempotencyKey: `cua-test-${worker.id}`,
  });
  const claimed = await tasks.claimNext(ctx.vmId, worker.id);
  if (!claimed) throw new Error("task was not claimed");
  await leases.acquire({
    vmId: ctx.vmId,
    owner: "worker",
    taskId: claimed.id,
    ttlMs: 60_000,
  });
  await workers.updateStatus(worker.id, "running", claimed.id);

  const policies = new CuaPolicyService(ctx.app.db, new SettingsService(ctx.app.db));
  const approvals = new ApprovalService(ctx.app.db, tasks, { pollIntervalMs: 25 });
  const guest = new FakeGuest();
  const cua = new CuaExecutionService(
    ctx.app.db,
    guest as unknown as GuestService,
    tasks,
    leaseRepository,
    policies,
    approvals,
  );
  await cua.startExecution({ taskId: claimed.id, workerId: worker.id, vmId: ctx.vmId });
  const tokenService = new CuaTokenService(ctx.app.db, { ttlMs: 60_000 });
  const issued = await tokenService.issue({
    workerId: worker.id,
    vmId: ctx.vmId,
    sessionId: "test-session",
    taskId: claimed.id,
  });
  return {
    ctx,
    tasks,
    leases,
    workers,
    policies,
    approvals,
    cua,
    guest,
    workerId: worker.id,
    taskId: claimed.id,
    token: issued.context,
  };
}

let harness: Harness | null = null;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness?.ctx.close();
  harness = null;
});

describe("CuaExecutionService", () => {
  it("observes, executes an action through the lease and records a task/worker trace", async () => {
    const h = harness!;
    const observation = await h.cua.observe(h.token);
    expect(observation.screenshotId).toMatch(/^observation-/);
    expect(observation.width).toBe(1280);

    const result = await h.cua.act(h.token, {
      action: { type: "click", point: { x: 100, y: 50 }, screenshotId: observation.screenshotId },
    });
    expect(result.ok).toBe(true);
    expect(h.guest.inputCalls).toHaveLength(1);
    expect(h.guest.inputCalls[0]?.action).toMatchObject({
      type: "click",
      point: { x: 100, y: 50 },
    });
    const trace = await h.cua.trace(h.taskId);
    expect(trace.execution?.stepCount).toBe(2);
    expect(trace.execution?.actionCount).toBe(1);
    expect(trace.actions).toHaveLength(1);
    expect(trace.actions[0]).toMatchObject({
      taskId: h.taskId,
      workerId: h.workerId,
      vmId: h.ctx.vmId,
      type: "click",
      status: "executed",
    });
    expect(trace.actions[0]?.leaseId).toBeTruthy();
    expect(trace.screenshots.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects actions without an observation, with a stale screenshot or without the lease", async () => {
    const h = harness!;
    await expect(
      h.cua.act(h.token, { action: { type: "click", point: { x: 10, y: 10 } } }),
    ).rejects.toMatchObject({ code: "conflict" });

    const observation = await h.cua.observe(h.token);
    const first = await h.cua.act(h.token, {
      action: { type: "click", point: { x: 10, y: 10 }, screenshotId: observation.screenshotId },
    });
    await expect(
      h.cua.act(h.token, {
        action: { type: "click", point: { x: 20, y: 20 }, screenshotId: observation.screenshotId },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(first.screenshotId).toMatch(/^after-/);

    const lease = await h.leases.getActive(h.ctx.vmId);
    await h.leases.release(h.ctx.vmId, lease!.id);
    await expect(
      h.cua.act(h.token, {
        action: { type: "click", point: { x: 20, y: 20 }, screenshotId: first.screenshotId },
      }),
    ).rejects.toBeTruthy();
  });

  it("executes Chinese typing, scrolling and normalized drags", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { approvalActionTypes: [] });
    let observation = await h.cua.observe(h.token);
    const typed = await h.cua.act(h.token, {
      action: { type: "type_text", text: "中文滚动拖拽", screenshotId: observation.screenshotId },
    });
    const scrolled = await h.cua.act(h.token, {
      action: {
        type: "scroll",
        deltaX: 0,
        deltaY: -240,
        point: { x: 320, y: 240 },
        screenshotId: typed.screenshotId,
      },
    });
    const dragged = await h.cua.act(h.token, {
      action: {
        type: "drag",
        from: { x: 0.1, y: 0.2 },
        to: { x: 0.6, y: 0.7 },
        coordinateSpace: "normalized",
        screenshotId: scrolled.screenshotId,
      },
    });
    expect(dragged.ok).toBe(true);
    expect(h.guest.inputCalls.map((call) => (call.action as { type: string }).type)).toEqual([
      "type_text",
      "scroll",
      "drag",
    ]);
    expect(h.guest.inputCalls[0]?.action).toMatchObject({ text: "中文滚动拖拽" });
    expect(h.guest.inputCalls[1]?.action).toMatchObject({
      type: "scroll",
      deltaY: -240,
      point: { x: 320, y: 240 },
    });
    expect(h.guest.inputCalls[2]?.action).toMatchObject({
      type: "drag",
      from: { x: 128, y: 144 },
      to: { x: 768, y: 504 },
    });
    observation = await h.cua.observe(h.token);
    expect(observation.width).toBe(1280);
  });

  it("rejects coordinates from a screenshot after the display resolution changed", async () => {
    const h = harness!;
    const observation = await h.cua.observe(h.token);
    h.guest.display = { ...h.guest.display, width: 1600, height: 900 };
    await expect(
      h.cua.act(h.token, {
        action: { type: "click", point: { x: 10, y: 10 }, screenshotId: observation.screenshotId },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await h.cua.execution(h.taskId))?.requiresObservation).toBe(true);
    const fresh = await h.cua.observe(h.token);
    expect(fresh.width).toBe(1600);
    const result = await h.cua.act(h.token, {
      action: {
        type: "click",
        point: { x: 0.5, y: 0.5 },
        coordinateSpace: "normalized",
        screenshotId: fresh.screenshotId,
      },
    });
    expect(result.ok).toBe(true);
    expect(h.guest.inputCalls.at(-1)?.action).toMatchObject({ point: { x: 800, y: 450 } });
  });

  it("waits for approval and executes the stored sensitive action only after approval", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { approvalActionTypes: ["type_text"] });
    const observation = await h.cua.observe(h.token);
    const pending = h.cua.act(h.token, {
      action: { type: "type_text", text: "你好，世界", screenshotId: observation.screenshotId },
    });
    let approvalId = "";
    for (let index = 0; index < 40 && !approvalId; index += 1) {
      const rows = await h.approvals.list({ taskId: h.taskId, status: "pending" });
      approvalId = rows[0]?.id ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(approvalId).not.toBe("");
    expect((await h.tasks.get(h.taskId))?.status).toBe("waiting_approval");
    expect(h.guest.inputCalls).toHaveLength(0);
    await h.approvals.resolve(approvalId, "approved", "local-user", "允许输入");
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(h.guest.inputCalls).toHaveLength(1);
    expect(h.guest.inputCalls[0]?.action).toMatchObject({ type: "type_text", text: "你好，世界" });
    const trace = await h.cua.trace(h.taskId);
    expect(trace.approvals[0]).toMatchObject({ status: "approved", resolvedBy: "local-user" });
    expect((await h.tasks.get(h.taskId))?.status).toBe("running");
  });

  it("rejects a denied sensitive action without executing it and records the tool result", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { approvalActionTypes: ["keypress"] });
    const observation = await h.cua.observe(h.token);
    const pending = h.cua.act(h.token, {
      action: { type: "keypress", keys: ["ctrl", "s"], screenshotId: observation.screenshotId },
    });
    let approvalId = "";
    for (let index = 0; index < 40 && !approvalId; index += 1) {
      approvalId = (await h.approvals.list({ taskId: h.taskId, status: "pending" }))[0]?.id ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await h.approvals.resolve(approvalId, "rejected", "local-user", "不要保存");
    await expect(pending).rejects.toMatchObject({ code: "forbidden" });
    expect(h.guest.inputCalls).toHaveLength(0);
    const trace = await h.cua.trace(h.taskId);
    expect(trace.approvals[0]?.status).toBe("rejected");
    const events = (await h.tasks.detail(h.taskId)).events.map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining(["task.approval_requested", "task.approval_resolved"]),
    );
  });

  it("rejects an approved action if the resolution changed while waiting", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { approvalActionTypes: ["type_text"] });
    const observation = await h.cua.observe(h.token);
    const pending = h.cua.act(h.token, {
      action: { type: "type_text", text: "stale", screenshotId: observation.screenshotId },
    });
    let approvalId = "";
    for (let index = 0; index < 40 && !approvalId; index += 1) {
      approvalId = (await h.approvals.list({ taskId: h.taskId, status: "pending" }))[0]?.id ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    h.guest.display = { ...h.guest.display, width: 1600, height: 900 };
    await h.approvals.resolve(approvalId, "approved");
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(h.guest.inputCalls).toHaveLength(0);
    expect((await h.tasks.get(h.taskId))?.status).toBe("running");
    expect((await h.cua.execution(h.taskId))?.requiresObservation).toBe(true);
  });

  it("does not block the worker heartbeat check behind a pending approval", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, {
      approvalActionTypes: ["type_text"],
      approvalTimeoutMs: 5_000,
    });
    const observation = await h.cua.observe(h.token);
    const pending = h.cua.act(h.token, {
      action: { type: "type_text", text: "pending", screenshotId: observation.screenshotId },
    });
    let approvalId = "";
    for (let index = 0; index < 40 && !approvalId; index += 1) {
      approvalId = (await h.approvals.list({ taskId: h.taskId, status: "pending" }))[0]?.id ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const started = Date.now();
    expect(await h.cua.expireIfNeeded(h.taskId)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
    await h.approvals.resolve(approvalId, "approved");
    await pending;
  });

  it("times out a pending approval and returns the task to running", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, {
      approvalActionTypes: ["type_text"],
      approvalTimeoutMs: 1_000,
    });
    const observation = await h.cua.observe(h.token);
    const started = Date.now();
    await expect(
      h.cua.act(h.token, {
        action: { type: "type_text", text: "late", screenshotId: observation.screenshotId },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const approvals = await h.approvals.list({ taskId: h.taskId });
    expect(approvals[0]?.status).toBe("timed_out");
    expect((await h.tasks.get(h.taskId))?.status).toBe("running");
    expect(h.guest.inputCalls).toHaveLength(0);
  });

  it("cancels a pending approval when the task is cancelled", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { approvalActionTypes: ["type_text"] });
    const observation = await h.cua.observe(h.token);
    const pending = h.cua.act(h.token, {
      action: { type: "type_text", text: "cancelled", screenshotId: observation.screenshotId },
    });
    let approvalId = "";
    for (let index = 0; index < 40 && !approvalId; index += 1) {
      approvalId = (await h.approvals.list({ taskId: h.taskId, status: "pending" }))[0]?.id ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await h.tasks.cancel(h.taskId, "user cancel");
    await expect(pending).rejects.toMatchObject({ code: "forbidden" });
    expect((await h.approvals.get(approvalId)).status).toBe("cancelled");
    expect(h.guest.inputCalls).toHaveLength(0);
  });

  it("stops a task at the configured step limit instead of clicking forever", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { maxSteps: 2, approvalActionTypes: [] });
    const observation = await h.cua.observe(h.token);
    const first = await h.cua.act(h.token, {
      action: { type: "click", point: { x: 5, y: 5 }, screenshotId: observation.screenshotId },
    });
    await expect(
      h.cua.act(h.token, {
        action: { type: "click", point: { x: 6, y: 6 }, screenshotId: first.screenshotId },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await h.tasks.get(h.taskId)).toMatchObject({
      status: "blocked",
      errorCode: "cua_step_limit",
    });
    expect((await h.cua.execution(h.taskId))?.outcome).toBe("blocked");
  });

  it("detects repeated actions with no screen change and blocks the task", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, {
      duplicateActionLimit: 2,
      noProgressLimit: 50,
      approvalActionTypes: [],
    });
    h.guest.screen = Buffer.from("same-frame");
    h.guest.advanceScreen = false;
    const observation = await h.cua.observe(h.token);
    let screenshotId = observation.screenshotId;
    let actionError: unknown = null;
    for (let index = 0; index < 3; index += 1) {
      try {
        const result = await h.cua.act(h.token, {
          action: { type: "click", point: { x: 10, y: 10 }, screenshotId },
        });
        screenshotId = result.screenshotId;
      } catch (error) {
        actionError = error;
        break;
      }
    }
    expect(actionError).toMatchObject({ code: "conflict" });
    expect(await h.tasks.get(h.taskId)).toMatchObject({
      status: "blocked",
      errorCode: "cua_duplicate_action",
    });
  });

  it("verifies file evidence on the guest before completing a task", async () => {
    const h = harness!;
    await h.cua.observe(h.token);
    const completed = await h.cua.complete(h.token, {
      summary: "报告已保存",
      evidence: [
        {
          type: "file",
          path: "/home/worker/workspace/report.txt",
          sha256: "a".repeat(64),
          sizeBytes: 12,
        },
      ],
    });
    expect(completed.completed).toBe(true);
    expect(h.guest.verifyCalls).toHaveLength(1);
    expect((await h.tasks.get(h.taskId))?.status).toBe("completed");
    expect((await h.cua.execution(h.taskId))?.outcome).toBe("completed");
    const events = (await h.tasks.detail(h.taskId)).events.map((event) => event.type);
    expect(events).toEqual(expect.arrayContaining(["worker.completion_verified"]));
  });

  it("blocks the task after three failed completion evidence attempts", async () => {
    const h = harness!;
    h.guest.verifyOk = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        h.cua.complete(h.token, {
          summary: "尝试完成",
          evidence: [{ type: "file", path: "/home/worker/workspace/missing.txt" }],
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(await h.tasks.get(h.taskId)).toMatchObject({
      status: "blocked",
      errorCode: "cua_completion_unverified",
    });
  });

  it("expires a task that exceeds its execution deadline", async () => {
    const h = harness!;
    await h.policies.update(h.ctx.projectId, { maxDurationMs: 1_000 });
    await h.ctx.app.db
      .updateTable("task_execution_state")
      .set({ deadline_at: new Date(Date.now() - 1_000).toISOString() })
      .where("task_id", "=", h.taskId)
      .execute();
    expect(await h.cua.expireIfNeeded(h.taskId)).toBe(true);
    expect((await h.tasks.get(h.taskId))?.errorCode).toBe("cua_execution_timeout");
  });
});

describe("CuaTokenService", () => {
  it("revokes old tokens and binds active tasks", async () => {
    const h = harness!;
    const issued = await h.ctx.app.db
      .selectFrom("cua_tokens")
      .selectAll()
      .where("worker_id", "=", h.workerId)
      .executeTakeFirst();
    expect(issued?.task_id).toBe(h.taskId);
    const service = new CuaTokenService(h.ctx.app.db, { ttlMs: 60_000 });
    await service.revokeAll("test_restart");
    const rows = await h.ctx.app.db
      .selectFrom("cua_tokens")
      .select(["revoked_at"])
      .where("worker_id", "=", h.workerId)
      .execute();
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });
});
