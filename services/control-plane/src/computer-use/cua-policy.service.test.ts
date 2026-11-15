import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { SettingsService } from "../settings/settings.service";
import { CuaPolicyService, DEFAULT_SENSITIVE_ACTIONS } from "./cua-policy.service";

let ctx: TestContext;
let policies: CuaPolicyService;
let settings: SettingsService;

beforeEach(async () => {
  ctx = await createTestContext();
  settings = new SettingsService(ctx.app.db);
  policies = new CuaPolicyService(ctx.app.db, settings);
});

afterEach(async () => {
  await ctx.close();
});

describe("CuaPolicyService", () => {
  it("uses global security settings to derive default sensitive actions", async () => {
    const enabled = await policies.view(ctx.projectId);
    expect(enabled.source).toBe("default");
    expect(enabled.policy.approvalActionTypes).toEqual(DEFAULT_SENSITIVE_ACTIONS);
    expect(enabled.policy.maxSteps).toBe(80);
    expect(enabled.policy.network.mode).toBe("unrestricted");
    expect(enabled.policy.credentials.allowInGuest).toBe(false);

    await settings.updatePreferences({
      security: { requireApprovalForSensitiveActions: false },
    });
    const disabled = await policies.view(ctx.projectId);
    expect(disabled.policy.approvalActionTypes).toEqual([]);
  });

  it("rejects broker_only because the current network backend cannot enforce it", async () => {
    await expect(
      policies.update(ctx.projectId, { network: { mode: "broker_only" } }),
    ).rejects.toThrow("网络隔离");
  });

  it("persists project overrides and merges nested policy objects", async () => {
    const updated = await policies.update(ctx.projectId, {
      maxSteps: 12,
      approvalActionTypes: ["type_text", "drag"],
      network: { allowedHosts: ["models.example.test"] },
      fileExchange: { allowedRoots: ["/home/worker/workspace", "C:\\Users\\aib-worker"] },
    });
    expect(updated.source).toBe("project");
    expect(updated.policy).toMatchObject({
      maxSteps: 12,
      approvalActionTypes: ["type_text", "drag"],
      network: { mode: "unrestricted", allowedHosts: ["models.example.test"] },
      fileExchange: {
        enabled: true,
        allowedRoots: ["/home/worker/workspace", "C:\\Users\\aib-worker"],
      },
    });

    const taskId = "policy-task";
    const now = new Date().toISOString();
    await ctx.app.db
      .insertInto("tasks")
      .values({
        id: taskId,
        project_id: ctx.projectId,
        vm_id: ctx.vmId,
        origin_conversation_id: ctx.conversationId,
        assigned_worker_id: null,
        parent_task_id: null,
        objective: "policy lookup",
        status: "queued",
        priority: 0,
        attempt_count: 0,
        latest_summary: null,
        result_json: null,
        error_code: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
      })
      .execute();
    const taskPolicy = await policies.effectiveForTask(taskId);
    expect(taskPolicy.maxSteps).toBe(12);
  });

  it("rejects unsafe or out-of-range policy values", async () => {
    await expect(policies.update(ctx.projectId, { maxSteps: 0 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      policies.update(ctx.projectId, { network: { allowedHosts: ["http://evil.test/path"] } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      policies.update(ctx.projectId, { fileExchange: { allowedRoots: ["/home/../etc"] } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      policies.update(ctx.projectId, {
        fileExchange: { allowedRoots: ["C:\\Users\\..\\Windows"] },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      policies.update(ctx.projectId, { fileExchange: { allowedRoots: ["C:\\"] } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      policies.update(ctx.projectId, { approvalActionTypes: ["open_firewall" as never] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
