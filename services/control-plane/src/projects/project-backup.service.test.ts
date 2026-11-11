import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupervisorVmState, VmPowerState } from "@agent-in-box/protocol";
import { storageLayout } from "@agent-in-box/config";
import type { DatabaseService } from "../persistence/database.service";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { nowIso } from "../persistence/time";
import type { GuestClient } from "../vms/guest.client";
import type { SupervisorClient } from "../vms/supervisor.client";
import { ProjectBackupService } from "./project-backup.service";

const ARCHIVE_BYTES = Buffer.from("phase9 project backup payload");

function runtime(id: string, powerState: VmPowerState): SupervisorVmState {
  return {
    id,
    powerState,
    pid: powerState === "stopped" ? 0 : 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: 17611,
    workerHostPort: 17612,
    consoleUrl: "vnc://127.0.0.1:5901",
    diskPath: "/tmp/disk.qcow2",
    guestHealth: "unknown",
    lastError: "",
    updatedAt: nowIso(),
  };
}

describe("ProjectBackupService", () => {
  let ctx: TestContext;
  let service: ProjectBackupService;
  let powerState: VmPowerState;
  let restoreCalls: Array<{ workspace: string; sha256: string }>;

  beforeEach(async () => {
    ctx = await createTestContext();
    powerState = "running";
    restoreCalls = [];
    const database = { layout: storageLayout(ctx.dir), dataRoot: ctx.dir } as DatabaseService;
    const supervisor = {
      get: async (id: string) => runtime(id, powerState),
    } as unknown as SupervisorClient;
    const guest = {
      downloadWorkspace: async (_target: unknown, _workspace: string, destination: string) => {
        await writeFile(destination, ARCHIVE_BYTES, { mode: 0o600 });
        return {
          sha256: createHash("sha256").update(ARCHIVE_BYTES).digest("hex"),
          sizeBytes: ARCHIVE_BYTES.byteLength,
          fileCount: 3,
        };
      },
      restoreWorkspace: async (_target: unknown, workspace: string, file: string) => {
        const bytes = await readFile(file);
        restoreCalls.push({
          workspace,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        return { fileCount: 3, sizeBytes: bytes.byteLength };
      },
    } as unknown as GuestClient;
    const leases = new LeaseService(ctx.app.db, new LeaseRepository(ctx.app.db));
    service = new ProjectBackupService(
      ctx.app.db,
      database,
      new OutboxRepository(ctx.app.db),
      leases,
      guest,
      supervisor,
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("creates an independent project workspace version and restores it", async () => {
    const artifactBytes = Buffer.from("phase9 artifact version");
    const artifactRoot = storageLayout(ctx.dir).artifacts;
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "result.txt"), artifactBytes, { mode: 0o600 });
    const now = nowIso();
    await ctx.app.db
      .insertInto("tasks")
      .values({
        id: "backup-task",
        project_id: ctx.projectId,
        vm_id: ctx.vmId,
        origin_conversation_id: ctx.conversationId,
        assigned_worker_id: null,
        parent_task_id: null,
        objective: "artifact-producing task",
        status: "completed",
        priority: 0,
        latest_summary: "done",
        error_code: null,
        created_at: now,
        started_at: now,
        completed_at: now,
      })
      .execute();
    await ctx.app.db
      .insertInto("task_artifacts")
      .values({
        id: "backup-artifact",
        project_id: ctx.projectId,
        task_id: "backup-task",
        name: "result.txt",
        relative_path: "result.txt",
        media_type: "text/plain",
        size_bytes: artifactBytes.byteLength,
        sha256: createHash("sha256").update(artifactBytes).digest("hex"),
        created_at: now,
        verified_at: now,
      })
      .execute();
    const backup = await service.create(ctx.projectId, { label: "before refactor" });
    expect(backup.status).toBe("available");
    expect(backup.bindings[0]?.fileCount).toBe(3);
    expect(backup.bindings[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backup.artifactSnapshot.map((artifact) => artifact.artifactId)).toEqual([
      "backup-artifact",
    ]);

    const impact = await service.impact(ctx.projectId, backup.id);
    expect(impact.blocked).toBe(false);

    const verified = await service.verify(ctx.projectId, backup.id);
    expect(verified.ok).toBe(true);
    expect(verified.artifacts).toEqual([
      {
        artifactId: "backup-artifact",
        relativePath: "result.txt",
        exists: true,
        sha256Matches: true,
        sizeMatches: true,
      },
    ]);

    await expect(
      service.restore(ctx.projectId, backup.id, { confirm: false }),
    ).rejects.toMatchObject({ code: "conflict" });
    const restored = await service.restore(ctx.projectId, backup.id, { confirm: true });
    expect(restored.status).toBe("restored");
    expect(restoreCalls).toEqual([
      {
        workspace: "/home/worker/workspace",
        sha256: backup.bindings[0]?.sha256,
      },
    ]);
  });

  it("blocks restore when another project shares the same workspace directory", async () => {
    const catalog = new CatalogRepository(ctx.app.db);
    const other = await catalog.createProject({ name: "Other project" });
    await catalog.bindVm({
      projectId: other.id,
      vmId: ctx.vmId,
      guestWorkspacePath: "/home/worker/workspace",
      isPrimary: true,
    });
    const backup = await service.create(ctx.projectId, { label: "shared" });
    const impact = await service.impact(ctx.projectId, backup.id);
    expect(impact.blocked).toBe(true);
    expect(impact.conflicts.some((conflict) => conflict.reason === "shared_workspace_path")).toBe(
      true,
    );
    await expect(
      service.restore(ctx.projectId, backup.id, { confirm: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(restoreCalls).toEqual([]);
  });

  it("requires a running VM and no active worker before backing up", async () => {
    powerState = "stopped";
    await expect(service.create(ctx.projectId)).rejects.toMatchObject({ code: "conflict" });
    powerState = "running";
    await ctx.app.db
      .insertInto("workers")
      .values({
        id: "active-worker",
        project_id: ctx.projectId,
        vm_id: ctx.vmId,
        conversation_id: ctx.conversationId,
        engine_type: "pi-rpc",
        engine_version: "1.5.1",
        status: "running",
        current_task_id: null,
        capability_set: "[]",
        created_at: nowIso(),
        last_active_at: nowIso(),
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
    await expect(service.create(ctx.projectId)).rejects.toMatchObject({ code: "conflict" });
  });
});
