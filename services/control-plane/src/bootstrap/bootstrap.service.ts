import os from "node:os";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  BootstrapStage,
  BootstrapState,
  BootstrapStatus,
  ImageRecord,
} from "@agent-in-box/protocol";
import type { Kysely } from "kysely";
import { HostInspectionService } from "../host/host-inspection.service";
import { ImageService } from "../images/image.service";
import { ModelValidationService } from "../models/model-validation.service";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { ProjectService } from "../projects/project.service";
import { RouterRuntimeService } from "../router/router-runtime.service";
import { SettingsService } from "../settings/settings.service";
import { VmService } from "../vms/vm.service";

const BOOTSTRAP_ID = "default";
const GIB = 1024 * 1024 * 1024;
const DEFAULT_PROJECT_NAME = "我的工作区";
const DEFAULT_VM_NAME = "默认工作环境";
const DEFAULT_GUEST_WORKSPACE = "/home/aib-worker/workspace";

export const BOOTSTRAP_OPTIONS = Symbol("AGENT_IN_BOX_BOOTSTRAP_OPTIONS");

export interface BootstrapOptions {
  autoResume?: boolean;
  pollIntervalMs?: number;
  provisioningTimeoutMs?: number;
}

interface BootstrapResources {
  imageId?: string | null;
  vmId?: string | null;
  projectId?: string | null;
  bindingId?: string | null;
}

interface BootstrapRow {
  status: string;
  stage: string;
  conversation_ready: number;
  progress_json: string;
  resource_ids_json: string;
  required_action: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

class BootstrapCancelled extends Error {}

@Injectable()
export class BootstrapService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BootstrapService.name);
  private readonly pollIntervalMs: number;
  private readonly provisioningTimeoutMs: number;
  private running: Promise<void> | null = null;
  private stopped = false;
  private cancelRequested = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly settings: SettingsService,
    private readonly validation: ModelValidationService,
    private readonly host: HostInspectionService,
    private readonly images: ImageService,
    private readonly vms: VmService,
    private readonly projects: ProjectService,
    @Optional() @Inject(BOOTSTRAP_OPTIONS) private readonly options: BootstrapOptions = {},
    @Optional() private readonly router?: RouterRuntimeService,
  ) {
    this.pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 1000);
    this.provisioningTimeoutMs = Math.max(
      this.pollIntervalMs,
      options.provisioningTimeoutMs ?? 45 * 60_000,
    );
  }

  onModuleInit(): void {
    if (this.options.autoResume === false) return;
    void this.resumeAfterRestart();
  }

  async onModuleDestroy(): Promise<void> {
    // ImageService aborts active downloads during shutdown. Do not hold process
    // teardown open while a large download or Guest provisioning is in flight.
    this.stopped = true;
  }

  async state(): Promise<BootstrapState> {
    const row = await this.row();
    if (!row) return emptyState();
    const resources = parseRecord(row.resource_ids_json) as BootstrapResources;
    return {
      status: normalizeStatus(row.status),
      stage: normalizeStage(row.stage),
      conversationReady: row.conversation_ready === 1 || row.status === "execution_ready",
      executionReady: row.status === "execution_ready",
      requiredAction: row.required_action as BootstrapState["requiredAction"],
      progress: parseRecord(row.progress_json),
      resources: {
        imageId: resources.imageId ?? null,
        vmId: resources.vmId ?? null,
        projectId: resources.projectId ?? null,
        bindingId: resources.bindingId ?? null,
      },
      error:
        row.error_code || row.error_message
          ? {
              code: row.error_code ?? "bootstrap_failed",
              message: row.error_message ?? "初始化未完成",
            }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async start(): Promise<BootstrapState> {
    this.stopped = false;
    if (this.running) return this.state();
    this.cancelRequested = false;
    // Set the single-flight marker synchronously, before any await, so two
    // concurrent start/retry calls cannot both create the default VM.
    this.running = this.beginStart()
      .catch((error: unknown) => {
        this.logger.warn(`Bootstrap start failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.state();
  }

  private async beginStart(): Promise<void> {
    const current = await this.state();
    if (current.status === "execution_ready") return;
    const now = nowIso();
    const existing = await this.row();
    if (!existing) {
      await this.db
        .insertInto("bootstrap_states")
        .values({
          id: BOOTSTRAP_ID,
          status: "running",
          stage: "validating_model",
          conversation_ready: 0,
          progress_json: "{}",
          resource_ids_json: "{}",
          required_action: null,
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        })
        .execute();
    } else {
      await this.update({
        status: "running",
        stage:
          current.conversationReady && current.requiredAction !== "configure_model"
            ? "checking_host"
            : "validating_model",
        required_action: null,
        error_code: null,
        error_message: null,
        completed_at: null,
      });
    }
    await this.run();
  }

  async cancel(): Promise<BootstrapState> {
    this.cancelRequested = true;
    const current = await this.state();
    if (current.resources.imageId) {
      const image = await this.images.get(current.resources.imageId).catch(() => null);
      if (image && ["downloading", "verifying"].includes(image.status)) {
        await this.images.cancel(image.id).catch(() => undefined);
      }
    }
    await this.update({
      status: "cancelled",
      required_action: null,
      error_code: null,
      error_message: null,
    });
    return this.state();
  }

  private async resumeAfterRestart(): Promise<void> {
    const row = await this.row();
    if (!row || row.status !== "running") return;
    if (row.stage === "provisioning_guest" && row.resource_ids_json.includes("vmId")) {
      // A running guest may finish provisioning while the application is closed.
      // The normal run loop reconciles its actual persisted state before waiting.
      this.logger.log("Resuming guest provisioning bootstrap");
    }
    await this.start();
  }

  private async run(): Promise<void> {
    try {
      if (this.cancelRequested) return;
      const state = await this.state();
      let validatedModel: Awaited<ReturnType<ModelValidationService["validate"]>> | null = null;
      if (!state.conversationReady || state.requiredAction === "configure_model") {
        await this.update({ status: "running", stage: "validating_model" });
        const selection = await this.settings.modelSelection();
        const selected = selection.worker ?? selection.router;
        const result = await this.validation.validate(selected ?? {});
        if (!result.ok) {
          const unavailable = result.error?.category === "unavailable";
          await this.update({
            status: unavailable ? "retryable_failed" : "blocked",
            conversation_ready: 0,
            required_action: unavailable ? "retry" : "configure_model",
            error_code: result.error?.code ?? "model_validation_failed",
            error_message: result.error?.message ?? "模型验证失败",
          });
          return;
        }
        validatedModel = result;
      }

      if (!(await this.ensureRouterRuntime())) return;
      if (!state.conversationReady) await this.update({ conversation_ready: 1 });
      await this.transition("checking_host");
      if (validatedModel && !validatedModel.supportsImage) {
        await this.waitForUser(
          "configure_model",
          "model_image_input_required",
          "当前模型可以用于对话，但执行虚拟机任务需要选择支持图片输入的模型",
        );
        return;
      }

      await this.update({ stage: "checking_host", status: "running" });
      const inspection = await this.host.inspect();
      if (!inspection.ready) {
        await this.waitForUser(
          "enable_virtualization",
          "host_not_ready",
          "这台电脑尚未满足虚拟机运行条件，请按环境检查提示处理后重试",
        );
        return;
      }

      await this.transition("preparing_runtime");
      const runtime = await this.vms.list();
      if (!runtime.supervisor.available) {
        await this.waitForUser(
          "install_runtime",
          "runtime_unavailable",
          "正在等待桌面应用准备虚拟机运行组件",
        );
        return;
      }

      await this.transition("preparing_image");
      const catalog = await this.images.list();
      let image = catalog.items.find(
        (candidate) =>
          candidate.osFamily === "linux" &&
          candidate.architecture === hostArchitecture() &&
          candidate.provisioningProfile === "linux-desktop-worker",
      );
      if (!image) {
        image = catalog.items.find(
          (candidate) =>
            candidate.osFamily === "linux" &&
            candidate.provisioningProfile === "linux-desktop-worker",
        );
      }
      if (!image) throw new PersistenceError("unavailable", "没有可用的默认 Linux 工作镜像");
      await this.resources({ imageId: image.id });
      if (image.status !== "available") image = await this.downloadImage(image.id);
      if ((await this.state()).status === "cancelled") return;
      if (image.status !== "available" || !image.localPath) {
        throw new PersistenceError("unavailable", "默认 Linux 镜像尚未通过完整性校验");
      }

      await this.transition("creating_default_vm");
      let vmId = (await this.state()).resources.vmId;
      let vm = vmId ? await this.vms.get(vmId) : null;
      if (!vm) {
        const resources = defaultVmResources();
        vm = await this.vms.create({
          name: DEFAULT_VM_NAME,
          imageId: image.id,
          cpuCount: resources.cpuCount,
          memoryGb: resources.memoryGb,
          diskGb: 40,
          provisioning: "auto",
        });
        vmId = vm.vm.id;
        await this.resources({ vmId });
      }

      if (vm.vm.provisioning.state !== "ready") {
        if (vm.vm.powerState !== "running") vm = await this.vms.start(vm.vm.id);
        await this.transition("provisioning_guest");
        await this.waitForGuest(vm.vm.id);
        if ((await this.state()).status === "cancelled") return;
      }

      await this.transition("creating_default_workspace");
      const project = await this.ensureDefaultProject(vm.vm.id);
      await this.transition("verifying_execution");
      vm = await this.vms.get(vm.vm.id);
      if (vm.vm.provisioning.state !== "ready") {
        throw new PersistenceError("unavailable", "Guest 尚未完成初始化，请重试验证");
      }
      const now = nowIso();
      await this.update({
        status: "execution_ready",
        stage: "execution_ready",
        required_action: null,
        error_code: null,
        error_message: null,
        completed_at: now,
      });
      await this.db
        .updateTable("bootstrap_states")
        .set({
          resource_ids_json: JSON.stringify({
            imageId: image.id,
            vmId: vm.vm.id,
            projectId: project.project.id,
            bindingId: project.project.defaultVmBindingId,
          } satisfies BootstrapResources),
        })
        .where("id", "=", BOOTSTRAP_ID)
        .execute();
    } catch (error) {
      if (error instanceof BootstrapCancelled || this.cancelRequested || this.stopped) return;
      const code = errorCode(error);
      await this.update({
        status: retryableCode(code) ? "retryable_failed" : "blocked",
        required_action: "retry",
        error_code: code,
        error_message: error instanceof Error ? error.message : String(error),
      });
      this.logger.warn(`Bootstrap paused: ${code}`);
    }
  }

  private async ensureRouterRuntime(): Promise<boolean> {
    if (!this.router) return true;
    const result = await this.router.preflight();
    if (result.ok) return true;
    await this.update({
      status: "blocked",
      conversation_ready: 0,
      required_action: "retry",
      error_code: "router_runtime_unavailable",
      error_message: result.message ?? "宿主 Router Pi 不可用",
    });
    return false;
  }

  private async downloadImage(imageId: string): Promise<ImageRecord> {
    let polling = true;
    const progress = (async () => {
      while (polling && !this.stopped) {
        const current = await this.images.get(imageId).catch(() => null);
        if (current) {
          await this.writeProgress({
            downloadedBytes: current.downloadedBytes,
            totalBytes: current.sizeBytes,
            ...(current.status === "verifying" ? { message: "正在校验镜像完整性" } : {}),
          }).catch(() => undefined);
        }
        await delay(this.pollIntervalMs);
      }
    })();
    try {
      return await this.images.download(imageId);
    } finally {
      polling = false;
      await progress;
    }
  }

  private async writeProgress(progress: BootstrapState["progress"]): Promise<void> {
    await this.db
      .updateTable("bootstrap_states")
      .set({ progress_json: JSON.stringify(progress), updated_at: nowIso() })
      .where("id", "=", BOOTSTRAP_ID)
      .execute();
  }

  private async waitForGuest(vmId: string): Promise<void> {
    const deadline = Date.now() + this.provisioningTimeoutMs;
    while (!this.stopped && Date.now() <= deadline) {
      if (this.cancelRequested) throw new BootstrapCancelled("cancelled");
      const current = await this.state();
      if (current.status === "cancelled") throw new BootstrapCancelled("cancelled");
      const vm = await this.vms.get(vmId);
      if (vm.vm.provisioning.state === "ready") return;
      if (vm.vm.provisioning.state === "failed") {
        throw new PersistenceError("unavailable", vm.vm.provisioning.message ?? "Guest 初始化失败");
      }
      await delay(this.pollIntervalMs);
    }
    if (!this.stopped) {
      throw new PersistenceError("unavailable", "Guest 初始化超时，可从当前阶段重试");
    }
  }

  private async ensureDefaultProject(vmId: string) {
    const saved = (await this.state()).resources.projectId;
    if (saved) {
      const project = await this.projects.get(saved);
      if (!project.bindings.some((binding) => binding.binding.vmId === vmId)) {
        const bound = await this.projects.bind(project.project.id, {
          vmId,
          guestWorkspacePath: DEFAULT_GUEST_WORKSPACE,
          isPrimary: true,
        });
        await this.resources({ bindingId: bound.project.defaultVmBindingId });
        return bound;
      }
      return project;
    }
    const existing = (await this.projects.list()).find(
      (candidate) =>
        candidate.project.name === DEFAULT_PROJECT_NAME &&
        candidate.bindings.some((binding) => binding.binding.vmId === vmId),
    );
    const project =
      existing ??
      (await this.projects.create({
        name: DEFAULT_PROJECT_NAME,
        description: "首次启动时自动创建的默认工作区",
        workspaceConfig: { defaultGuestWorkspacePath: DEFAULT_GUEST_WORKSPACE },
      }));
    await this.resources({ projectId: project.project.id });
    if (!project.bindings.some((binding) => binding.binding.vmId === vmId)) {
      const bound = await this.projects.bind(project.project.id, {
        vmId,
        guestWorkspacePath: DEFAULT_GUEST_WORKSPACE,
        isPrimary: true,
      });
      await this.resources({ bindingId: bound.project.defaultVmBindingId });
      return bound;
    }
    await this.resources({ bindingId: project.project.defaultVmBindingId });
    return project;
  }

  private async transition(stage: BootstrapStage) {
    if (this.cancelRequested) throw new BootstrapCancelled("cancelled");
    await this.update({
      status: "running",
      stage,
      required_action: null,
      error_code: null,
      error_message: null,
    });
    return this.state();
  }

  private async waitForUser(
    action: NonNullable<BootstrapState["requiredAction"]>,
    code: string,
    message: string,
  ): Promise<void> {
    await this.update({
      status: "waiting_user_action",
      required_action: action,
      error_code: code,
      error_message: message,
    });
  }

  private async resources(patch: BootstrapResources): Promise<void> {
    const current = (await this.state()).resources;
    await this.db
      .updateTable("bootstrap_states")
      .set({
        resource_ids_json: JSON.stringify({
          imageId: patch.imageId ?? current.imageId,
          vmId: patch.vmId ?? current.vmId,
          projectId: patch.projectId ?? current.projectId,
          bindingId: patch.bindingId ?? current.bindingId,
        } satisfies BootstrapResources),
        updated_at: nowIso(),
      })
      .where("id", "=", BOOTSTRAP_ID)
      .execute();
  }

  private async update(patch: {
    status?: BootstrapStatus;
    stage?: BootstrapStage;
    conversation_ready?: number;
    required_action?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    completed_at?: string | null;
  }): Promise<void> {
    await this.db
      .updateTable("bootstrap_states")
      .set({ ...patch, updated_at: nowIso() })
      .where("id", "=", BOOTSTRAP_ID)
      .execute();
  }

  private async row(): Promise<BootstrapRow | undefined> {
    return this.db
      .selectFrom("bootstrap_states")
      .selectAll()
      .where("id", "=", BOOTSTRAP_ID)
      .executeTakeFirst();
  }
}

function emptyState(): BootstrapState {
  const now = nowIso();
  return {
    status: "not_started",
    stage: "not_started",
    conversationReady: false,
    executionReady: false,
    requiredAction: null,
    progress: {},
    resources: { imageId: null, vmId: null, projectId: null, bindingId: null },
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeStatus(value: string): BootstrapStatus {
  const values: BootstrapStatus[] = [
    "not_started",
    "running",
    "waiting_user_action",
    "retryable_failed",
    "blocked",
    "cancelled",
    "execution_ready",
  ];
  return values.includes(value as BootstrapStatus) ? (value as BootstrapStatus) : "blocked";
}

function normalizeStage(value: string): BootstrapStage {
  const values: BootstrapStage[] = [
    "not_started",
    "preferences_saved",
    "validating_model",
    "checking_host",
    "preparing_runtime",
    "preparing_image",
    "creating_default_vm",
    "provisioning_guest",
    "creating_default_workspace",
    "verifying_execution",
    "execution_ready",
  ];
  return values.includes(value as BootstrapStage)
    ? (value as BootstrapStage)
    : "verifying_execution";
}

function defaultVmResources(): { cpuCount: number; memoryGb: number } {
  const totalGb = Math.floor(os.totalmem() / GIB);
  const memoryGb = totalGb >= 24 ? 8 : totalGb >= 12 ? 4 : 2;
  return { cpuCount: Math.max(2, Math.min(4, os.cpus().length >> 1)), memoryGb };
}

function hostArchitecture(): "amd64" | "arm64" {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "bootstrap_failed";
}

function retryableCode(code: string): boolean {
  return [
    "unavailable",
    "provider_connection_error",
    "provider_timeout",
    "download_failed",
    "network_error",
  ].includes(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
