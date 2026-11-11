import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorVmState, VmPowerState } from "@agent-in-box/protocol";
import { storageLayout } from "@agent-in-box/config";
import { ImageService } from "../images/image.service";
import { AppDatabase } from "../persistence/database";
import type { DatabaseService } from "../persistence/database.service";
import { CatalogRepository } from "../persistence/repositories/catalog-repository";
import { nowIso } from "../persistence/time";
import type { SupervisorClient, SupervisorCreateSpec } from "./supervisor.client";
import { VmService } from "./vm.service";

function runtime(id: string, powerState: VmPowerState = "stopped"): SupervisorVmState {
  return {
    id,
    powerState,
    pid: powerState === "stopped" ? 0 : 4242,
    qmpPort: 14444,
    sshHostPort: 10022,
    guestHostPort: 17611,
    consoleUrl: "vnc://127.0.0.1:5900",
    diskPath: path.join("vm-root", id, "disk.qcow2"),
    guestHealth: "unknown",
    lastError: "",
    updatedAt: nowIso(),
  };
}

describe("VmService", () => {
  let directory: string;
  let app: AppDatabase;
  let states: Map<string, SupervisorVmState>;
  let supervisor: SupervisorClient;
  let createSpec: SupervisorCreateSpec | undefined;
  let service: VmService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-vms-"));
    app = AppDatabase.open({ filename: path.join(directory, "test.sqlite") });
    await app.migrate();
    const baseImage = path.join(directory, "base.qcow2");
    await writeFile(baseImage, "verified test base");
    const now = nowIso();
    await app.db
      .insertInto("images")
      .values({
        id: "linux-v1",
        name: "Linux test",
        os_family: "linux",
        os_version: "24.04",
        architecture: "amd64",
        version: "v1",
        status: "available",
        size_bytes: 17,
        checksum: "a".repeat(64),
        local_path: baseImage,
        created_at: now,
        verified_at: now,
        source_url: "https://images.example.test/base.qcow2",
        file_name: "base.qcow2",
        downloaded_bytes: 17,
        error_code: null,
        error_message: null,
        updated_at: now,
        seed_local_path: null,
        manifest_json: "",
      })
      .execute();

    states = new Map();
    createSpec = undefined;
    const fake = {
      create: vi.fn(async (spec: SupervisorCreateSpec) => {
        createSpec = spec;
        const state = runtime(spec.id);
        states.set(spec.id, state);
        return state;
      }),
      list: vi.fn(async () => [...states.values()]),
      get: vi.fn(async (id: string) => states.get(id) ?? runtime(id)),
      start: vi.fn(async (id: string) => {
        const state = runtime(id, "running");
        states.set(id, state);
        return state;
      }),
      stop: vi.fn(async (id: string) => {
        const state = runtime(id);
        states.set(id, state);
        return state;
      }),
      suspend: vi.fn(async (id: string) => {
        const state = runtime(id, "suspended");
        states.set(id, state);
        return state;
      }),
      resume: vi.fn(async (id: string) => {
        const state = runtime(id, "running");
        states.set(id, state);
        return state;
      }),
      console: vi.fn(async (id: string) => states.get(id)?.consoleUrl ?? "vnc://127.0.0.1:5900"),
    };
    supervisor = fake as unknown as SupervisorClient;
    const database = {
      layout: storageLayout(directory),
      dataRoot: directory,
    } as DatabaseService;
    const images = new ImageService(database, app.db, { autoResume: false });
    service = new VmService(database, app.db, images, supervisor, {
      guestFetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
      guestTimeoutMs: 50,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function createVm(name = "Linux desktop") {
    return service.create({ name, imageId: "linux-v1", cpuCount: 2, memoryGb: 2, diskGb: 20 });
  }

  it("creates independent stopped overlays from an Available Linux image", async () => {
    const first = await createVm();
    const second = await createVm("Second Linux desktop");

    expect(first.vm.id).not.toBe(second.vm.id);
    expect(first.vm.powerState).toBe("stopped");
    expect(first.vm.guestHealth).toBe("unknown");
    expect(createSpec).toMatchObject({
      name: "Second Linux desktop",
      cpuCount: 2,
      memoryMb: 2048,
      diskSizeGb: 20,
      desktop: true,
      guestHostPort: 0,
    });
    expect(createSpec?.baseImagePath).toBe(path.join(directory, "base.qcow2"));
    expect(first.vm.storageRoot).toBe(path.join(directory, "vms", first.vm.id));
    expect(second.vm.storageRoot).not.toBe(first.vm.storageRoot);
  });

  it("rejects unverified images and Windows guests before calling Supervisor", async () => {
    await app.db.updateTable("images").set({ status: "failed", verified_at: null }).execute();
    await expect(createVm()).rejects.toMatchObject({ code: "conflict" });
    expect(supervisor.create).not.toHaveBeenCalled();
  });

  it("reconciles process state separately from guest health after a service restart", async () => {
    const created = await createVm();
    states.set(created.vm.id, runtime(created.vm.id, "running"));
    const restarted = new VmService(
      { layout: storageLayout(directory), dataRoot: directory } as DatabaseService,
      app.db,
      new ImageService(
        { layout: storageLayout(directory), dataRoot: directory } as DatabaseService,
        app.db,
        { autoResume: false },
      ),
      supervisor,
      { guestFetchImpl: async () => new Response("{}", { status: 503 }), guestTimeoutMs: 50 },
    );

    const result = await restarted.list();
    expect(result.supervisor.available).toBe(true);
    expect(result.items[0]?.vm.powerState).toBe("running");
    expect(result.items[0]?.vm.guestHealth).toBe("unreachable");
    expect(result.items[0]?.runtime?.guestHealth).toBe("unreachable");

    await restarted.suspend(created.vm.id);
    expect((await restarted.list()).items[0]?.vm.powerState).toBe("suspended");
    await restarted.resume(created.vm.id);
    expect((await restarted.list()).items[0]?.vm.powerState).toBe("running");
  });

  it("persists idempotent stop results, power events, bindings and the current task", async () => {
    const created = await createVm();
    await service.start(created.vm.id);
    const catalog = new CatalogRepository(app.db);
    const project = await catalog.createProject({ name: "Shared project" });
    await catalog.bindVm({
      projectId: project.id,
      vmId: created.vm.id,
      guestWorkspacePath: "/home/aib/work",
      isPrimary: true,
    });
    const conversation = await catalog.createConversation({
      kind: "project",
      projectId: project.id,
      title: "Task conversation",
    });
    await app.db
      .insertInto("tasks")
      .values({
        id: "task-1",
        project_id: project.id,
        vm_id: created.vm.id,
        origin_conversation_id: conversation.id,
        assigned_worker_id: null,
        parent_task_id: null,
        objective: "Verify the VM board",
        status: "running",
        priority: 10,
        latest_summary: null,
        error_code: null,
        created_at: nowIso(),
        started_at: nowIso(),
        completed_at: null,
      })
      .execute();

    await service.stop(created.vm.id);
    const stoppedAgain = await service.stop(created.vm.id);
    expect(stoppedAgain.vm.powerState).toBe("stopped");
    expect(stoppedAgain.vm.guestHealth).toBe("unknown");
    expect(stoppedAgain.boundProjects).toEqual([
      { id: project.id, name: "Shared project", isPrimary: true, archivedAt: null },
    ]);
    expect(stoppedAgain.currentTask).toMatchObject({ id: "task-1", status: "running" });
    const events = await app.db
      .selectFrom("outbox")
      .selectAll()
      .where("topic", "=", "vm.power_changed")
      .execute();
    expect(events.some((event) => event.payload_json.includes('"to":"stopped"'))).toBe(true);
    await expect(service.console(created.vm.id)).rejects.toMatchObject({ code: "conflict" });
  });
});
