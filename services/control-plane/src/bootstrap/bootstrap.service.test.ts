import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  BootstrapState,
  HostInspectionReport,
  ImageCatalog,
  ImageRecord,
  ModelValidationResult,
  ProjectDetail,
  ProjectView,
  VmInstanceView,
  VmListResponse,
} from "@agent-in-box/protocol";
import type { HostInspectionService } from "../host/host-inspection.service";
import type { ImageService } from "../images/image.service";
import type { ModelValidationService } from "../models/model-validation.service";
import { AppDatabase } from "../persistence/database";
import type { ProjectService } from "../projects/project.service";
import type { SettingsService } from "../settings/settings.service";
import type { VmService } from "../vms/vm.service";
import { BootstrapService } from "./bootstrap.service";

const NOW = "2026-01-01T00:00:00.000Z";
const WORKSPACE = "/home/aib-worker/workspace";

interface Fakes {
  settings: { modelSelection: Mock };
  validation: { validate: Mock };
  host: { inspect: Mock };
  images: { list: Mock; get: Mock; download: Mock; cancel: Mock };
  vms: { list: Mock; get: Mock; create: Mock; start: Mock };
  projects: { get: Mock; list: Mock; create: Mock; bind: Mock };
}

function imageRecord(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: "image-1",
    name: "Linux desktop worker",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: process.arch === "arm64" ? "arm64" : "amd64",
    version: "1.0.0",
    status: "available",
    sizeBytes: 1024,
    checksum: "checksum",
    localPath: "/images/linux.qcow2",
    createdAt: NOW,
    verifiedAt: NOW,
    sourceUrl: "https://example.invalid/linux.qcow2",
    fileName: "linux.qcow2",
    downloadedBytes: 1024,
    errorCode: null,
    errorMessage: null,
    updatedAt: NOW,
    seedLocalPath: null,
    provisioningProfile: "linux-desktop-worker",
    ...overrides,
  };
}

function imageCatalog(...items: ImageRecord[]): ImageCatalog {
  return { source: "test-manifest", allowedHosts: [], items };
}

function validationResult(overrides: Partial<ModelValidationResult> = {}): ModelValidationResult {
  return {
    ok: true,
    providerId: "anthropic",
    model: "claude-sonnet",
    supportsImage: true,
    checkedAt: NOW,
    latencyMs: 5,
    upstreamStatus: 200,
    error: null,
    ...overrides,
  };
}

function vmView(
  provisioning: "waiting" | "ready" | "failed" = "ready",
  powerState: "stopped" | "running" = "running",
): VmInstanceView {
  return {
    vm: {
      id: "vm-1",
      name: "默认工作环境",
      imageId: "image-1",
      osFamily: "linux",
      cpuCount: 2,
      memoryBytes: 2 * 1024 ** 3,
      diskBytes: 40 * 1024 ** 3,
      storageRoot: "/vms/vm-1",
      powerState,
      guestHealth: provisioning === "ready" ? "healthy" : "starting",
      createdAt: NOW,
      lastStartedAt: null,
      provisioning: { state: provisioning, message: null, startedAt: null },
    },
    runtime: null,
    diskUsageBytes: 0,
    boundProjects: [],
    currentTask: null,
    queue: [],
    activeWorkers: [],
    sharing: {} as never,
    scheduling: {} as never,
  };
}

function projectDetail(options: { id?: string; vmId?: string | null } = {}): ProjectDetail {
  const id = options.id ?? "project-1";
  const vmId = options.vmId ?? null;
  return {
    project: {
      id,
      name: "我的工作区",
      description: "首次启动时自动创建的默认工作区",
      defaultVmBindingId: vmId ? "binding-1" : null,
      workspaceConfig: { defaultGuestWorkspacePath: WORKSPACE },
      agentConfig: { mcpEnabled: false },
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    },
    bindings: vmId
      ? [
          {
            binding: {
              id: "binding-1",
              projectId: id,
              vmId,
              guestWorkspacePath: WORKSPACE,
              isPrimary: true,
              createdAt: NOW,
            },
            vm: vmView().vm,
            sharedProjects: [],
            sharedActiveTaskCount: 0,
            activeWorkers: [],
            queueDepth: 0,
          },
        ]
      : [],
    conversationCount: 0,
    activeTaskCount: 0,
    activeWorkerCount: 0,
    conversations: [],
    activities: [],
    artifacts: [],
  };
}

async function waitForState(
  service: BootstrapService,
  predicate: (state: BootstrapState) => boolean,
): Promise<BootstrapState> {
  const deadline = Date.now() + 5_000;
  let state = await service.state();
  while (!predicate(state)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for bootstrap state: ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = await service.state();
  }
  return state;
}

describe("BootstrapService", () => {
  let dir: string;
  let app: AppDatabase;
  let service: BootstrapService;
  let fakes: Fakes;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aib-bootstrap-"));
    app = AppDatabase.open({ filename: path.join(dir, "test.sqlite") });
    await app.migrate();

    fakes = {
      settings: {
        modelSelection: vi.fn(async () => ({
          worker: { providerId: "anthropic", model: "claude-sonnet" },
          router: null,
        })),
      },
      validation: { validate: vi.fn(async () => validationResult()) },
      host: {
        inspect: vi.fn(async () => ({ ready: true }) as unknown as HostInspectionReport),
      },
      images: {
        list: vi.fn(async () => imageCatalog(imageRecord())),
        get: vi.fn(async () => imageRecord()),
        download: vi.fn(async () => imageRecord()),
        cancel: vi.fn(async () => imageRecord({ status: "cancelled" })),
      },
      vms: {
        list: vi.fn(async (): Promise<VmListResponse> => ({
          items: [],
          supervisor: { available: true, message: null },
        })),
        get: vi.fn(async () => vmView()),
        create: vi.fn(async () => vmView()),
        start: vi.fn(async () => vmView()),
      },
      projects: {
        get: vi.fn(async () => projectDetail({ vmId: "vm-1" })),
        list: vi.fn(async (): Promise<ProjectView[]> => []),
        create: vi.fn(async () => projectDetail()),
        bind: vi.fn(async () => projectDetail({ vmId: "vm-1" })),
      },
    };

    service = new BootstrapService(
      app.db,
      fakes.settings as unknown as SettingsService,
      fakes.validation as unknown as ModelValidationService,
      fakes.host as unknown as HostInspectionService,
      fakes.images as unknown as ImageService,
      fakes.vms as unknown as VmService,
      fakes.projects as unknown as ProjectService,
      { autoResume: false, pollIntervalMs: 20, provisioningTimeoutMs: 2_000 },
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy().catch(() => undefined);
    if (app.sqlite.open) await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    {
      label: "configuration failure",
      result: validationResult({
        ok: false,
        upstreamStatus: 401,
        error: {
          code: "provider_authentication_failed",
          category: "validation_failed",
          message: "模型服务鉴权失败",
        },
      }),
      status: "blocked",
      action: "configure_model",
      code: "provider_authentication_failed",
    },
    {
      label: "unavailable provider",
      result: validationResult({
        ok: false,
        upstreamStatus: null,
        latencyMs: null,
        error: {
          code: "provider_unreachable",
          category: "unavailable",
          message: "无法连接模型服务",
        },
      }),
      status: "retryable_failed",
      action: "retry",
      code: "provider_unreachable",
    },
  ])("pauses when model validation fails: $label", async ({ result, status, action, code }) => {
    fakes.validation.validate.mockResolvedValue(result);

    await service.start();
    const state = await waitForState(service, (current) => current.status === status);

    expect(state).toMatchObject({
      status,
      stage: "validating_model",
      conversationReady: false,
      executionReady: false,
      requiredAction: action,
      error: { code },
    });
    expect(fakes.validation.validate).toHaveBeenCalledWith({
      providerId: "anthropic",
      model: "claude-sonnet",
    });
    expect(fakes.host.inspect).not.toHaveBeenCalled();
    expect(fakes.vms.create).not.toHaveBeenCalled();
  });

  it("keeps a text-only model in conversation mode and asks for an image-capable model", async () => {
    fakes.validation.validate.mockResolvedValue(validationResult({ supportsImage: false }));

    await service.start();
    const state = await waitForState(
      service,
      (current) => current.status === "waiting_user_action",
    );

    expect(state).toMatchObject({
      status: "waiting_user_action",
      stage: "checking_host",
      conversationReady: true,
      executionReady: false,
      requiredAction: "configure_model",
      error: { code: "model_image_input_required" },
    });
    expect(fakes.host.inspect).not.toHaveBeenCalled();
    expect(fakes.images.list).not.toHaveBeenCalled();
    expect(fakes.vms.create).not.toHaveBeenCalled();
  });

  it("waits for the desktop runtime when the VM supervisor is unavailable", async () => {
    fakes.vms.list.mockResolvedValue({
      items: [],
      supervisor: { available: false, message: "supervisor not started" },
    });

    await service.start();
    const state = await waitForState(
      service,
      (current) => current.status === "waiting_user_action",
    );

    expect(state).toMatchObject({
      status: "waiting_user_action",
      stage: "preparing_runtime",
      conversationReady: true,
      requiredAction: "install_runtime",
      error: { code: "runtime_unavailable" },
    });
    expect(fakes.host.inspect).toHaveBeenCalledTimes(1);
    expect(fakes.images.list).not.toHaveBeenCalled();
    expect(fakes.vms.create).not.toHaveBeenCalled();
  });

  it("downloads the image, creates the VM and binds the default project", async () => {
    let guestReady = false;
    fakes.images.list.mockResolvedValue(
      imageCatalog(imageRecord({ status: "downloading", localPath: null, verifiedAt: null })),
    );
    fakes.images.download.mockResolvedValue(imageRecord());
    fakes.vms.create.mockResolvedValue(vmView("waiting", "stopped"));
    fakes.vms.start.mockImplementation(async () => {
      guestReady = true;
      return vmView("waiting", "running");
    });
    fakes.vms.get.mockImplementation(async () =>
      guestReady ? vmView("ready", "running") : vmView("waiting", "stopped"),
    );
    fakes.projects.list.mockResolvedValue([]);
    fakes.projects.create.mockResolvedValue(projectDetail());
    fakes.projects.bind.mockResolvedValue(projectDetail({ vmId: "vm-1" }));

    await service.start();
    const state = await waitForState(service, (current) => current.status === "execution_ready");

    expect(state).toMatchObject({
      status: "execution_ready",
      stage: "execution_ready",
      conversationReady: true,
      executionReady: true,
      requiredAction: null,
      error: null,
      completedAt: expect.any(String),
      resources: {
        imageId: "image-1",
        vmId: "vm-1",
        projectId: "project-1",
        bindingId: "binding-1",
      },
    });
    expect(fakes.images.download).toHaveBeenCalledWith("image-1");
    expect(fakes.vms.create).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: "image-1", provisioning: "auto", diskGb: 40 }),
    );
    expect(fakes.vms.start).toHaveBeenCalledWith("vm-1");
    expect(fakes.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "我的工作区" }),
    );
    expect(fakes.projects.bind).toHaveBeenCalledWith("project-1", {
      vmId: "vm-1",
      guestWorkspacePath: WORKSPACE,
      isPrimary: true,
    });
  });

  it("resumes from persisted resources and stays idempotent once execution is ready", async () => {
    await app.db
      .insertInto("bootstrap_states")
      .values({
        id: "default",
        status: "running",
        stage: "checking_host",
        conversation_ready: 1,
        progress_json: "{}",
        resource_ids_json: JSON.stringify({
          imageId: "image-1",
          vmId: "vm-1",
          projectId: "project-1",
          bindingId: "binding-1",
        }),
        required_action: null,
        error_code: null,
        error_message: null,
        created_at: NOW,
        updated_at: NOW,
        completed_at: null,
      })
      .execute();
    fakes.projects.get.mockResolvedValue(projectDetail({ vmId: "vm-1" }));

    await service.start();
    const state = await waitForState(service, (current) => current.status === "execution_ready");

    expect(state.resources).toEqual({
      imageId: "image-1",
      vmId: "vm-1",
      projectId: "project-1",
      bindingId: "binding-1",
    });
    expect(fakes.validation.validate).not.toHaveBeenCalled();
    expect(fakes.images.download).not.toHaveBeenCalled();
    expect(fakes.vms.create).not.toHaveBeenCalled();
    expect(fakes.vms.start).not.toHaveBeenCalled();
    expect(fakes.projects.create).not.toHaveBeenCalled();
    expect(fakes.projects.bind).not.toHaveBeenCalled();
    expect(fakes.host.inspect).toHaveBeenCalledTimes(1);

    const again = await service.start();
    expect(again.status).toBe("execution_ready");
    expect(fakes.host.inspect).toHaveBeenCalledTimes(1);
    expect(fakes.vms.list).toHaveBeenCalledTimes(1);
  });

  it("cancels a guest provisioning wait and aborts an active image download", async () => {
    fakes.images.get.mockResolvedValue(imageRecord({ status: "downloading", localPath: null }));
    fakes.vms.create.mockResolvedValue(vmView("waiting", "stopped"));
    fakes.vms.start.mockResolvedValue(vmView("waiting", "running"));
    fakes.vms.get.mockResolvedValue(vmView("waiting", "running"));

    await service.start();
    await waitForState(service, (current) => current.stage === "provisioning_guest");

    const cancelled = await service.cancel();
    expect(cancelled).toMatchObject({
      status: "cancelled",
      executionReady: false,
      requiredAction: null,
    });
    expect(fakes.images.cancel).toHaveBeenCalledWith("image-1");
    expect(fakes.projects.create).not.toHaveBeenCalled();

    const settled = await waitForState(service, (current) => current.status === "cancelled");
    expect(settled.resources.imageId).toBe("image-1");
  });
});
