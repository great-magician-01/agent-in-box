import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import {
  assertActionFitsDisplay,
  computerActionSignature,
  convertComputerActionCoordinates,
  validateComputerAction,
  type ComputerAction,
} from "@agent-in-box/computer-use";
import type {
  ComputerActionType,
  CuaActionRecord,
  CuaActionStatus,
  CuaApprovalRecord,
  CuaCompleteRequest,
  CuaCompleteResult,
  CuaEvidenceResult,
  CuaPolicy,
  CuaScreenshotKind,
  CuaScreenshotRecord,
  GuestInputAction,
  GuestVerifyCheck,
  HumanVerificationRecord,
  TaskExecutionStateView,
  TaskRecord,
  TaskTraceView,
} from "@agent-in-box/protocol";
import { guestPathEqualsOrWithin, isSafeAbsoluteGuestPath } from "@agent-in-box/domain";
import { toHumanVerificationRecord } from "../persistence/mappers";
import { redactText } from "../security/redaction";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { TaskService } from "../persistence/services/task-service";
import { GuestService } from "../vms/guest.service";
import { ApprovalService } from "./approval.service";
import { CuaPolicyService } from "./cua-policy.service";
import type { CuaTokenContext } from "./cua-token.service";

export const CUA_EXECUTION_OPTIONS = Symbol("AGENT_IN_BOX_CUA_EXECUTION_OPTIONS");

export interface CuaExecutionOptions {
  now?: () => Date;
}

export interface CuaActionInput {
  action: ComputerAction;
  screenshotId?: string;
  actionId?: string;
  timeoutMs?: number;
}

export interface HumanVerificationRequestInput {
  reason: string;
  screenshotId: string;
}

export interface CuaObservation {
  taskId: string;
  screenshotId: string;
  width: number;
  height: number;
  dpi: number;
  scaleFactor: number;
  sha256: string;
  dataBase64: string;
}

export interface CuaActionResult {
  taskId: string;
  actionId: string;
  status: CuaActionStatus;
  ok: boolean;
  screenshotId: string;
  afterScreenshot: {
    screenshotId: string;
    width: number;
    height: number;
    dpi: number;
    scaleFactor: number;
    dataBase64: string;
  };
}

interface TaskBinding {
  task: TaskRecord;
  workerId: string;
  vmId: string;
  projectId: string;
  storageRoot: string;
  leaseId: string;
}

const WAIT_ACTION = new Set<ComputerActionType>(["wait"]);

@Injectable()
export class CuaExecutionService {
  private readonly logger = new Logger(CuaExecutionService.name);
  private readonly now: () => Date;
  private readonly taskLocks = new Map<string, Promise<void>>();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly guest: GuestService,
    private readonly tasks: TaskService,
    private readonly leaseRepository: LeaseRepository,
    private readonly policies: CuaPolicyService,
    private readonly approvals: ApprovalService,
    @Optional() @Inject(CUA_EXECUTION_OPTIONS) options: CuaExecutionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async startExecution(input: {
    taskId: string;
    workerId: string;
    vmId: string;
  }): Promise<TaskExecutionStateView> {
    const policy = await this.policies.effectiveForTask(input.taskId);
    const startedAt = this.now();
    const deadlineAt = new Date(startedAt.getTime() + policy.maxDurationMs);
    await this.db
      .insertInto("task_execution_state")
      .values({
        task_id: input.taskId,
        worker_id: input.workerId,
        vm_id: input.vmId,
        started_at: startedAt.toISOString(),
        deadline_at: deadlineAt.toISOString(),
        step_count: 0,
        action_count: 0,
        no_progress_streak: 0,
        duplicate_streak: 0,
        completion_attempts: 0,
        requires_observation: 1,
        last_action_signature: null,
        last_action_at: null,
        ended_at: null,
        outcome: null,
      })
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          worker_id: input.workerId,
          vm_id: input.vmId,
          started_at: startedAt.toISOString(),
          deadline_at: deadlineAt.toISOString(),
          step_count: 0,
          action_count: 0,
          no_progress_streak: 0,
          duplicate_streak: 0,
          completion_attempts: 0,
          requires_observation: 1,
          last_action_signature: null,
          last_action_at: null,
          ended_at: null,
          outcome: null,
        }),
      )
      .execute();
    return (await this.execution(input.taskId)) as TaskExecutionStateView;
  }

  async finishExecution(
    taskId: string,
    outcome: "completed" | "waiting_human" | "blocked" | "failed" | "cancelled",
  ): Promise<void> {
    await this.db
      .updateTable("task_execution_state")
      .set({ ended_at: nowIso(), outcome })
      .where("task_id", "=", taskId)
      .where("ended_at", "is", null)
      .execute();
    if (outcome !== "completed") await this.approvals.cancelForTask(taskId, `任务已${outcome}`);
  }

  /** Called from the Worker heartbeat tick so an idle Pi cannot hold the VM forever. */
  async expireIfNeeded(taskId: string): Promise<boolean> {
    // Never block the worker heartbeat/renewal loop behind an in-flight action
    // or approval wait; the next tick checks again once the action completes.
    if (this.taskLocks.has(taskId)) return false;
    return this.withTaskLock(taskId, async () => {
      const execution = await this.execution(taskId);
      if (!execution || execution.endedAt) return false;
      if (new Date(execution.deadlineAt).getTime() > this.now().getTime()) return false;
      const task = await this.tasks.get(taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status)) return false;
      await this.blockTask(
        task,
        "cua_execution_timeout",
        "任务超过最大执行时间，已停止并等待用户处理；不会重放旧的桌面动作",
      );
      return true;
    });
  }

  async observe(
    token: CuaTokenContext,
    input: { actionId?: string } = {},
  ): Promise<CuaObservation> {
    const binding = await this.requireBinding(token, ["running"]);
    return this.withTaskLock(binding.task.id, async () => {
      const policy = await this.policies.effective(binding.projectId);
      await this.consumeStep(binding.task, policy);
      let observed: Awaited<ReturnType<GuestService["observe"]>>;
      try {
        observed = await this.guest.observe(binding.vmId);
      } catch (error) {
        await this.blockForHumanRequired(binding.task, error);
        throw error;
      }
      const screenshot = await this.storeScreenshot(
        binding,
        "observation",
        observed.screenshot.dataBase64,
        observed.desktop.width,
        observed.desktop.height,
        observed.desktop.dpi ?? null,
        observed.desktop.scaleFactor ?? null,
      );
      await this.db
        .updateTable("task_execution_state")
        .set({ requires_observation: 0 })
        .where("task_id", "=", binding.task.id)
        .execute();
      await this.tasks.recordWorkerEvent(binding.task.id, "worker.observation", {
        actionId: input.actionId ?? screenshot.id,
        screenshotId: screenshot.id,
        width: screenshot.width,
        height: screenshot.height,
        dpi: screenshot.dpi,
        scaleFactor: screenshot.scaleFactor,
      });
      return {
        taskId: binding.task.id,
        screenshotId: screenshot.id,
        width: screenshot.width,
        height: screenshot.height,
        dpi: observed.desktop.dpi ?? 96,
        scaleFactor: observed.desktop.scaleFactor ?? 1,
        sha256: screenshot.sha256,
        dataBase64: observed.screenshot.dataBase64,
      };
    });
  }

  async act(
    token: CuaTokenContext,
    input: CuaActionInput,
    signal?: AbortSignal,
  ): Promise<CuaActionResult> {
    const binding = await this.requireBinding(token, ["running"]);
    return this.withTaskLock(binding.task.id, async () => {
      const policy = await this.policies.effective(binding.projectId);
      const validation = validateComputerAction(input.action);
      if (!validation.ok) {
        await this.recordRejectedAction(
          binding,
          input,
          "invalid_action",
          validation.errors.join("; "),
        );
        throw new PersistenceError(
          "validation_failed",
          `Computer Use 动作无效：${validation.errors.join("; ")}`,
        );
      }
      const action = input.action;
      if (action.type === "screenshot") {
        throw new PersistenceError("validation_failed", "截图请使用 observe 工具");
      }
      const screenshotId =
        input.screenshotId ?? ("screenshotId" in action ? action.screenshotId : undefined);
      if (!WAIT_ACTION.has(action.type) && !screenshotId) {
        await this.recordRejectedAction(
          binding,
          input,
          "observation_required",
          "执行动作前必须先观察当前 VM 屏幕",
        );
        throw new PersistenceError("conflict", "执行动作前必须先观察当前 VM 屏幕（vm_screenshot）");
      }
      const execution = await this.execution(binding.task.id);
      if (!execution) throw new PersistenceError("conflict", "任务没有执行状态记录");
      if (execution.requiresObservation && !WAIT_ACTION.has(action.type)) {
        await this.recordRejectedAction(
          binding,
          input,
          "observation_required",
          "屏幕布局或 VM 上下文已变化，请重新观察",
        );
        throw new PersistenceError(
          "conflict",
          "屏幕布局或 VM 上下文已变化，请重新观察后再执行动作",
        );
      }

      let source: CuaScreenshotRecord | null = null;
      if (screenshotId) {
        source = await this.screenshotRecord(binding.task.id, screenshotId);
        const latest = await this.latestScreenshot(binding.task.id);
        if (!latest || latest.id !== source.id) {
          await this.recordRejectedAction(
            binding,
            input,
            "stale_screenshot",
            "引用的截图不是最新观察；请使用最近一次截图或重新观察",
          );
          throw new PersistenceError("conflict", "引用的截图已过期，请重新观察后再执行动作");
        }
        const desktop = await this.guest.desktop(binding.vmId);
        if (desktop.width !== source.width || desktop.height !== source.height) {
          await this.db
            .updateTable("task_execution_state")
            .set({ requires_observation: 1 })
            .where("task_id", "=", binding.task.id)
            .execute();
          await this.recordRejectedAction(
            binding,
            input,
            "screen_changed",
            `显示分辨率从 ${source.width}x${source.height} 变为 ${desktop.width}x${desktop.height}`,
          );
          throw new PersistenceError(
            "conflict",
            "显示分辨率已变化，旧截图上的坐标已失效，请重新观察",
          );
        }
      }

      const converted = await this.convertAction(action, binding, source);
      if (source) {
        const fits = assertActionFitsDisplay(converted, {
          width: source.width,
          height: source.height,
        });
        if (!fits.ok) {
          await this.recordRejectedAction(
            binding,
            input,
            "coordinate_out_of_bounds",
            fits.errors.join("; "),
          );
          throw new PersistenceError(
            "validation_failed",
            `动作坐标超出当前显示范围：${fits.errors.join("; ")}`,
          );
        }
      }
      const step = await this.consumeStep(binding.task, policy);
      const actionId = validateActionId(input.actionId) ?? randomUUID();
      const actionRow = await this.insertAction(binding, actionId, converted, source);
      const needsApproval = policy.approvalActionTypes.includes(action.type);
      if (needsApproval) {
        return this.runWithApproval(binding, policy, actionRow, converted, signal);
      }
      return this.executeAction(binding, policy, actionRow, converted, step);
    });
  }

  /**
   * The multimodal Worker model decided that the current screen needs the
   * human's identity/device. The host does not re-classify the screenshot; it
   * records the model's reasoning and hands the task to the human while keeping
   * the VM execution slot reserved.
   */
  async requestHumanVerification(
    token: CuaTokenContext,
    input: HumanVerificationRequestInput,
  ): Promise<HumanVerificationRecord> {
    const binding = await this.requireBinding(token, ["running"]);
    return this.withTaskLock(binding.task.id, async () => {
      const reason = typeof input?.reason === "string" ? redactText(input.reason).trim() : "";
      if (!reason || reason.length > 1000) {
        throw new PersistenceError("validation_failed", "人工处理说明必须为 1～1000 个字符");
      }
      const screenshotId = typeof input?.screenshotId === "string" ? input.screenshotId.trim() : "";
      if (!screenshotId) {
        throw new PersistenceError("validation_failed", "请求人工处理前必须先观察 VM 屏幕");
      }
      const source = await this.screenshotRecord(binding.task.id, screenshotId);
      const latest = await this.latestScreenshot(binding.task.id);
      if (!latest || latest.id !== source.id) {
        throw new PersistenceError(
          "conflict",
          "引用的截图不是最新观察；请重新观察后再请求人工处理",
        );
      }
      const desktop = await this.guest.desktop(binding.vmId);
      if (desktop.width !== source.width || desktop.height !== source.height) {
        await this.db
          .updateTable("task_execution_state")
          .set({ requires_observation: 1 })
          .where("task_id", "=", binding.task.id)
          .execute();
        throw new PersistenceError(
          "conflict",
          "显示分辨率已变化，截图已失效；请重新观察后再请求人工处理",
        );
      }
      const execution = await this.execution(binding.task.id);
      if (!execution) throw new PersistenceError("conflict", "任务没有执行状态记录");
      if (new Date(execution.deadlineAt).getTime() <= this.now().getTime()) {
        await this.blockTask(
          binding.task,
          "cua_execution_timeout",
          "任务超过最大执行时间，人工处理请求被拒绝",
        );
        throw new PersistenceError("conflict", "任务超过最大执行时间，人工处理请求被拒绝");
      }
      let record: HumanVerificationRecord;
      try {
        record = await this.tasks.beginHumanVerification({
          taskId: binding.task.id,
          workerId: binding.workerId,
          vmId: binding.vmId,
          reason,
          screenshotId: source.id,
        });
      } catch (error) {
        if (
          error instanceof PersistenceError &&
          typeof error.details === "object" &&
          error.details !== null &&
          (error.details as { code?: unknown }).code === "human_verification_limit"
        ) {
          await this.blockTask(
            binding.task,
            "human_verification_limit",
            "人工处理请求次数已达上限，任务已停止以避免 Worker 继续操作验证页面",
          );
        }
        throw error;
      }
      await this.finishExecution(binding.task.id, "waiting_human");
      return record;
    });
  }

  async complete(token: CuaTokenContext, input: CuaCompleteRequest): Promise<CuaCompleteResult> {
    const binding = await this.requireBinding(token, ["running"]);
    return this.withTaskLock(binding.task.id, async () => {
      const policy = await this.policies.effective(binding.projectId);
      const validationError = validateCompletion(input, policy);
      if (validationError) {
        throw new PersistenceError("validation_failed", validationError);
      }
      const execution = await this.execution(binding.task.id);
      if (!execution) throw new PersistenceError("conflict", "任务没有执行状态记录");
      if (new Date(execution.deadlineAt).getTime() <= this.now().getTime()) {
        await this.blockTask(
          binding.task,
          "cua_execution_timeout",
          "任务超过最大执行时间，完成校验被拒绝",
        );
        throw new PersistenceError("conflict", "任务超过最大执行时间，完成校验被拒绝");
      }
      const attempts = execution.completionAttempts + 1;
      await this.db
        .updateTable("task_execution_state")
        .set({ completion_attempts: attempts })
        .where("task_id", "=", binding.task.id)
        .execute();
      if (attempts > 3) {
        await this.blockTask(
          binding.task,
          "cua_completion_unverified",
          "任务完成证据连续校验失败，已停止 Worker 以避免无限重试",
        );
        throw new PersistenceError("conflict", "完成证据校验次数已达上限，任务已阻塞");
      }

      const evidence: CuaEvidenceResult[] = [];
      const guestChecks: GuestVerifyCheck[] = [];
      const guestIndexes: number[] = [];
      let verificationError: string | null = null;
      for (const item of input.evidence) {
        if (item.type === "screenshot") {
          const record = await this.screenshotRecord(binding.task.id, item.screenshotId);
          let fresh: Awaited<ReturnType<GuestService["observe"]>>;
          try {
            fresh = await this.guest.observe(binding.vmId);
          } catch (error) {
            await this.blockForHumanRequired(binding.task, error);
            throw error;
          }
          const completionShot = await this.storeScreenshot(
            binding,
            "completion",
            fresh.screenshot.dataBase64,
            fresh.desktop.width,
            fresh.desktop.height,
            fresh.desktop.dpi ?? null,
            fresh.desktop.scaleFactor ?? null,
          );
          evidence.push({
            type: "screenshot",
            verified: true,
            detail: `已重新捕获完成时屏幕，引用截图 ${record.id}`,
            screenshotId: completionShot.id,
          });
          continue;
        }
        if (item.type === "file") {
          if (!policy.fileExchange.enabled) {
            verificationError = "项目策略禁止文件交换证据";
            break;
          }
          if (!pathAllowed(item.path, policy.fileExchange.allowedRoots)) {
            verificationError = `文件证据不在允许的工作区根目录内：${item.path}`;
            break;
          }
          if (item.sizeBytes !== undefined && item.sizeBytes > policy.fileExchange.maxBytes) {
            verificationError = "文件证据超过项目策略大小上限";
            break;
          }
          guestIndexes.push(evidence.length);
          guestChecks.push({
            type: "file",
            path: item.path,
            ...(item.sha256 ? { sha256: item.sha256.toLowerCase() } : {}),
            ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
          });
          evidence.push({
            type: "file",
            verified: false,
            detail: "等待 Guest 校验",
            path: item.path,
          });
          continue;
        }
        if (item.type === "process") {
          guestIndexes.push(evidence.length);
          guestChecks.push({ type: "process", name: item.name });
          evidence.push({
            type: "process",
            verified: false,
            detail: "等待 Guest 校验",
          });
        }
      }
      if (!verificationError && guestChecks.length > 0) {
        const result = await this.guest.verify(binding.vmId, { checks: guestChecks });
        for (let index = 0; index < guestIndexes.length; index += 1) {
          const target = guestIndexes[index];
          const check = result.checks[index];
          if (target === undefined || !check) {
            verificationError = "Guest 校验结果不完整";
            break;
          }
          evidence[target] = {
            type: check.type,
            verified: check.ok,
            detail: check.ok ? "Guest 独立校验通过" : (check.error ?? "Guest 校验失败"),
            ...(check.path ? { path: check.path } : {}),
            ...(check.sha256 ? { sha256: check.sha256 } : {}),
            ...(check.sizeBytes !== undefined ? { sizeBytes: check.sizeBytes } : {}),
            ...(check.pids ? { pids: check.pids } : {}),
          };
          if (!check.ok) {
            verificationError = check.error ?? "Guest 校验失败";
            break;
          }
          if (
            check.type === "file" &&
            check.sizeBytes !== undefined &&
            check.sizeBytes > policy.fileExchange.maxBytes
          ) {
            verificationError = "文件证据超过项目策略大小上限";
            break;
          }
        }
      }
      if (verificationError) {
        await this.tasks.recordWorkerEvent(binding.task.id, "worker.completion_rejected", {
          attempt: attempts,
          error: verificationError,
          evidence,
        });
        if (attempts >= 3) {
          await this.blockTask(binding.task, "cua_completion_unverified", verificationError);
        }
        throw new PersistenceError("validation_failed", `完成证据校验失败：${verificationError}`, {
          evidence,
        });
      }
      if (!evidence.every((item) => item.verified)) {
        throw new PersistenceError("validation_failed", "完成证据未全部通过独立校验", { evidence });
      }

      await this.tasks.complete(binding.task.id, {
        summary: input.summary,
        result: {
          evidence,
          workerId: binding.workerId,
          verifiedAt: nowIso(),
        },
      });
      await this.tasks.recordWorkerEvent(binding.task.id, "worker.completion_verified", {
        workerId: binding.workerId,
        evidence,
      });
      await this.finishExecution(binding.task.id, "completed");
      return { taskId: binding.task.id, completed: true, evidence };
    });
  }

  async trace(taskId: string): Promise<TaskTraceView> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new PersistenceError("not_found", `任务不存在：${taskId}`);
    const [execution, actions, screenshots, approvals, humanVerifications] = await Promise.all([
      this.execution(taskId),
      this.db
        .selectFrom("cua_actions")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute(),
      this.db
        .selectFrom("cua_screenshots")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("captured_at", "asc")
        .orderBy("id", "asc")
        .execute(),
      this.db
        .selectFrom("cua_approvals")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("requested_at", "asc")
        .execute(),
      this.db
        .selectFrom("human_verifications")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("requested_at", "asc")
        .execute(),
    ]);
    return {
      taskId,
      execution: execution ?? null,
      actions: actions.map(toActionRecord),
      screenshots: screenshots.map(toScreenshotRecord),
      approvals: approvals.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        workerId: row.worker_id,
        actionId: row.action_id,
        actionType: row.action_type as ComputerActionType,
        contextSummary: row.context_summary,
        status: row.status as CuaApprovalRecord["status"],
        requestedAt: row.requested_at,
        expiresAt: row.expires_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        resolutionNote: row.resolution_note,
      })),
      humanVerifications: humanVerifications.map(toHumanVerificationRecord),
    };
  }

  async readScreenshot(
    taskId: string,
    screenshotId: string,
  ): Promise<{ data: Buffer; record: CuaScreenshotRecord }> {
    const row = await this.db
      .selectFrom("cua_screenshots")
      .selectAll()
      .where("id", "=", screenshotId)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", "截图不存在或不属于该任务");
    let data: Buffer;
    try {
      data = await readFile(row.file_path);
    } catch {
      throw new PersistenceError("not_found", "截图文件已不存在");
    }
    return { data, record: toScreenshotRecord(row) };
  }

  async execution(taskId: string): Promise<TaskExecutionStateView | undefined> {
    const row = await this.db
      .selectFrom("task_execution_state")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      workerId: row.worker_id,
      vmId: row.vm_id,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
      stepCount: row.step_count,
      actionCount: row.action_count,
      noProgressStreak: row.no_progress_streak,
      duplicateStreak: row.duplicate_streak,
      completionAttempts: row.completion_attempts,
      requiresObservation: row.requires_observation === 1,
      endedAt: row.ended_at,
      outcome: row.outcome as TaskExecutionStateView["outcome"],
    };
  }

  private async runWithApproval(
    binding: TaskBinding,
    policy: CuaPolicy,
    actionRow: ActionRow,
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<CuaActionResult> {
    await this.tasks.transition(binding.task.id, "waiting_approval", {
      summary: `等待人工批准 ${action.type} 动作`,
    });
    let approval: CuaApprovalRecord;
    try {
      approval = await this.approvals.request({
        taskId: binding.task.id,
        workerId: binding.workerId,
        actionId: actionRow.id,
        actionType: action.type,
        action,
        contextSummary: approvalSummary(binding.task, action),
        timeoutMs: policy.approvalTimeoutMs,
      });
    } catch (error) {
      const current = await this.tasks.get(binding.task.id);
      if (current?.status === "waiting_approval") {
        await this.tasks.transition(binding.task.id, "running", {
          summary: "审批请求创建失败，动作未执行",
        });
      }
      await this.updateActionFailure(
        actionRow.id,
        "approval_request_failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    await this.db
      .updateTable("cua_actions")
      .set({ status: "pending_approval", approval_id: approval.id })
      .where("id", "=", actionRow.id)
      .execute();

    const remaining = Math.max(0, new Date(approval.expiresAt).getTime() - this.now().getTime());
    const resolved = await this.approvals.waitForResolution(
      approval.id,
      remaining,
      signal,
      async () => {
        const task = await this.tasks.get(binding.task.id);
        if (!task || !["running", "waiting_approval"].includes(task.status)) return false;
        const execution = await this.execution(binding.task.id);
        if (!execution || execution.endedAt) return false;
        return new Date(execution.deadlineAt).getTime() > this.now().getTime();
      },
    );
    const task = await this.tasks.get(binding.task.id);
    if (resolved.status !== "approved") {
      if (task && task.status === "waiting_approval") {
        await this.tasks.transition(binding.task.id, "running", {
          summary: `审批 ${resolved.status}：${action.type} 动作未执行`,
        });
      }
      const code =
        resolved.status === "rejected"
          ? "approval_rejected"
          : resolved.status === "timed_out"
            ? "approval_timeout"
            : "approval_cancelled";
      await this.updateActionFailure(actionRow.id, code, `审批${resolved.status}，动作未执行`);
      throw new PersistenceError(
        resolved.status === "timed_out" ? "conflict" : "forbidden",
        `人工审批${resolved.status === "rejected" ? "被拒绝" : resolved.status === "timed_out" ? "超时" : "已取消"}，${action.type} 动作未执行`,
      );
    }
    if (!task || task.status !== "waiting_approval") {
      await this.updateActionFailure(
        actionRow.id,
        "task_not_running",
        "审批通过时任务已不在等待状态",
      );
      throw new PersistenceError("conflict", "审批通过时任务已取消或结束，动作未执行");
    }
    const approvedSource = await this.sourceShot(actionRow);
    if (approvedSource) {
      const desktop = await this.guest.desktop(binding.vmId);
      if (desktop.width !== approvedSource.width || desktop.height !== approvedSource.height) {
        await this.tasks.transition(binding.task.id, "running", {
          summary: "审批期间分辨率变化，动作未执行",
        });
        await this.db
          .updateTable("task_execution_state")
          .set({ requires_observation: 1 })
          .where("task_id", "=", binding.task.id)
          .execute();
        await this.updateActionFailure(
          actionRow.id,
          "screen_changed_before_execution",
          "审批期间显示分辨率变化，拒绝执行旧坐标",
        );
        throw new PersistenceError("conflict", "审批期间显示分辨率变化，请重新观察后重试");
      }
    }
    await this.tasks.transition(binding.task.id, "running", {
      summary: `人工已批准 ${action.type} 动作`,
    });
    const current = await this.tasks.get(binding.task.id);
    if (!current) throw new PersistenceError("not_found", "任务已不存在");
    return this.executeAction(
      binding,
      policy,
      { ...actionRow, status: "pending_approval" },
      action,
      0,
      true,
    );
  }

  private async executeAction(
    binding: TaskBinding,
    policy: CuaPolicy,
    actionRow: ActionRow,
    action: ComputerAction,
    step: number,
    approved = false,
  ): Promise<CuaActionResult> {
    const started = performance.now();
    let guestResult: { actionId: string; ok: boolean; error?: string };
    try {
      guestResult = await this.guest.input(binding.vmId, {
        leaseId: binding.leaseId,
        actionId: actionRow.id,
        action: toGuestAction(action),
        ...(action.type === "wait" || action.type === "screenshot" ? {} : { timeoutMs: 30_000 }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateActionFailure(actionRow.id, "guest_input_failed", message);
      if (error instanceof PersistenceError && error.code === "lease_conflict") {
        await this.blockTask(
          binding.task,
          "human_control_active",
          "人工已接管该 VM，Computer Use 动作被拒绝",
        );
      }
      await this.blockForHumanRequired(binding.task, error);
      throw error;
    }
    const executedAt = this.now();
    const after = await this.captureAfter(binding);
    const source = await this.sourceShot(actionRow);
    const afterHash = after?.sha256 ?? null;
    const signature = computerActionSignature(action);
    const unchanged = afterHash !== null && source !== null && afterHash === source.sha256;
    const state = await this.db
      .selectFrom("task_execution_state")
      .select(["action_count", "duplicate_streak", "no_progress_streak", "last_action_signature"])
      .where("task_id", "=", binding.task.id)
      .executeTakeFirst();
    const duplicate =
      unchanged && !WAIT_ACTION.has(action.type) && state?.last_action_signature === signature;
    const duplicateStreak = duplicate ? (state?.duplicate_streak ?? 0) + 1 : 0;
    const noProgressStreak =
      unchanged && !WAIT_ACTION.has(action.type) ? (state?.no_progress_streak ?? 0) + 1 : 0;
    await this.db
      .updateTable("task_execution_state")
      .set({
        action_count: (state?.action_count ?? 0) + 1,
        duplicate_streak: duplicateStreak,
        no_progress_streak: noProgressStreak,
        last_action_signature: signature,
        last_action_at: executedAt.toISOString(),
        requires_observation: after ? 0 : 1,
      })
      .where("task_id", "=", binding.task.id)
      .execute();
    const displayChanged = Boolean(
      after && source && (after.width !== source.width || after.height !== source.height),
    );
    const result = {
      ok: guestResult.ok,
      guestActionId: guestResult.actionId,
      afterScreenshotId: after?.id ?? null,
      displayChanged,
      approved,
      step,
    };
    await this.db
      .updateTable("cua_actions")
      .set({
        status: guestResult.ok ? "executed" : "failed",
        result_json: JSON.stringify(result),
        executed_at: executedAt.toISOString(),
        duration_ms: Math.round(performance.now() - started),
        error_code: guestResult.ok ? null : "guest_action_failed",
        error_message: guestResult.error ?? null,
        after_screenshot_id: after?.id ?? null,
      })
      .where("id", "=", actionRow.id)
      .execute();

    if (!guestResult.ok) {
      throw new PersistenceError(
        "unavailable",
        `Guest 动作执行失败：${guestResult.error ?? "unknown"}`,
      );
    }
    if (duplicateStreak >= policy.duplicateActionLimit) {
      await this.blockTask(
        binding.task,
        "cua_duplicate_action",
        `连续 ${duplicateStreak} 次重复动作且屏幕无变化，任务已停止`,
      );
      throw new PersistenceError("conflict", "检测到重复动作且屏幕无变化，任务已阻塞");
    }
    if (noProgressStreak >= policy.noProgressLimit) {
      await this.blockTask(
        binding.task,
        "cua_no_progress",
        `连续 ${noProgressStreak} 次动作后屏幕无变化，任务已停止`,
      );
      throw new PersistenceError("conflict", "检测到连续无进展，任务已阻塞");
    }
    if (!after) {
      throw new PersistenceError("unavailable", "动作已执行，但无法重新捕获屏幕状态");
    }
    return {
      taskId: binding.task.id,
      actionId: actionRow.id,
      status: guestResult.ok ? "executed" : "failed",
      ok: guestResult.ok,
      screenshotId: after.id,
      afterScreenshot: {
        screenshotId: after.id,
        width: after.width,
        height: after.height,
        dpi: after.dpi ?? 96,
        scaleFactor: after.scaleFactor ?? 1,
        dataBase64: (await this.readScreenshot(binding.task.id, after.id)).data.toString("base64"),
      },
    };
  }

  private async captureAfter(binding: TaskBinding): Promise<CuaScreenshotRecord | null> {
    try {
      const observed = await this.guest.observe(binding.vmId);
      return await this.storeScreenshot(
        binding,
        "after",
        observed.screenshot.dataBase64,
        observed.desktop.width,
        observed.desktop.height,
        observed.desktop.dpi ?? null,
        observed.desktop.scaleFactor ?? null,
      );
    } catch (error) {
      await this.blockForHumanRequired(binding.task, error);
      this.logger.warn(
        `Post-action screenshot failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private async sourceShot(
    actionRow: ActionRow,
  ): Promise<{ sha256: string; width: number; height: number } | null> {
    if (!actionRow.beforeScreenshotId) return null;
    const row = await this.db
      .selectFrom("cua_screenshots")
      .select(["sha256", "width", "height"])
      .where("id", "=", actionRow.beforeScreenshotId)
      .executeTakeFirst();
    return row ? { sha256: row.sha256, width: row.width, height: row.height } : null;
  }

  private async insertAction(
    binding: TaskBinding,
    actionId: string,
    action: ComputerAction,
    source: CuaScreenshotRecord | null,
  ): Promise<ActionRow> {
    const existing = await this.db
      .selectFrom("cua_actions")
      .select("id")
      .where("id", "=", actionId)
      .executeTakeFirst();
    if (existing) throw new PersistenceError("conflict", "动作 ID 已被使用");
    const display = source
      ? {
          width: source.width,
          height: source.height,
          dpi: source.dpi,
          scaleFactor: source.scaleFactor,
        }
      : await this.display(binding.vmId);
    await this.db
      .insertInto("cua_actions")
      .values({
        id: actionId,
        task_id: binding.task.id,
        worker_id: binding.workerId,
        vm_id: binding.vmId,
        lease_id: binding.leaseId,
        action_type: action.type,
        action_json: JSON.stringify(action),
        source_screenshot_id: source?.id ?? null,
        before_screenshot_id: source?.id ?? null,
        after_screenshot_id: null,
        display_json: JSON.stringify(display),
        status: "pending_approval",
        result_json: null,
        error_code: null,
        error_message: null,
        approval_id: null,
        created_at: this.now().toISOString(),
        executed_at: null,
        duration_ms: null,
      })
      .execute();
    return {
      id: actionId,
      type: action.type,
      beforeScreenshotId: source?.id ?? null,
      status: "pending_approval",
    };
  }

  private async recordRejectedAction(
    binding: TaskBinding,
    input: CuaActionInput,
    code: string,
    message: string,
  ): Promise<void> {
    const action = input.action;
    if (!action || typeof action.type !== "string") return;
    const actionId = validateActionId(input.actionId) ?? randomUUID();
    const screenshotId =
      input.screenshotId ?? ("screenshotId" in action ? action.screenshotId : undefined);
    let source: CuaScreenshotRecord | null = null;
    if (screenshotId) {
      try {
        source = await this.screenshotRecord(binding.task.id, screenshotId);
      } catch {
        source = null;
      }
    }
    try {
      await this.insertAction(binding, actionId, action, source ?? null);
    } catch {
      // A rejected attempt must never mask the original validation error.
      return;
    }
    await this.db
      .updateTable("cua_actions")
      .set({ status: "blocked", error_code: code, error_message: message.slice(0, 2000) })
      .where("id", "=", actionId)
      .execute();
  }

  private async updateActionFailure(
    actionId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.db
      .updateTable("cua_actions")
      .set({
        status: "failed",
        error_code: code,
        error_message: message.slice(0, 2000),
        executed_at: this.now().toISOString(),
      })
      .where("id", "=", actionId)
      .execute();
  }

  private async consumeStep(task: TaskRecord, policy: CuaPolicy): Promise<number> {
    const execution = await this.execution(task.id);
    if (!execution) throw new PersistenceError("conflict", "任务没有执行状态记录");
    if (new Date(execution.deadlineAt).getTime() <= this.now().getTime()) {
      await this.blockTask(
        task,
        "cua_execution_timeout",
        "任务超过最大执行时间，已停止并等待用户处理",
      );
      throw new PersistenceError("conflict", "任务超过最大执行时间，已停止");
    }
    const step = execution.stepCount + 1;
    if (step > policy.maxSteps) {
      await this.blockTask(
        task,
        "cua_step_limit",
        `任务超过最大步数 ${policy.maxSteps}，已停止以避免无限点击`,
      );
      throw new PersistenceError("conflict", `任务超过最大步数 ${policy.maxSteps}，已停止`);
    }
    await this.db
      .updateTable("task_execution_state")
      .set({ step_count: step })
      .where("task_id", "=", task.id)
      .execute();
    return step;
  }

  private async blockForHumanRequired(task: TaskRecord, error: unknown): Promise<void> {
    if (!isHumanRequiredGuestError(error)) return;
    await this.blockTask(
      task,
      "guest_session_locked",
      "Guest 的锁屏或安全桌面需要人工接管；已停止自动操作，不跳过系统安全机制",
    );
  }

  private async blockTask(task: TaskRecord, code: string, message: string): Promise<void> {
    const current = await this.tasks.get(task.id);
    if (!current || !["running", "waiting_approval"].includes(current.status)) return;
    await this.approvals.cancelForTask(task.id, message);
    await this.tasks.block(task.id, code, message, message);
    await this.finishExecution(task.id, "blocked");
  }

  private async requireBinding(
    token: CuaTokenContext,
    statuses: TaskRecord["status"][],
  ): Promise<TaskBinding> {
    if (!token.taskId) {
      throw new PersistenceError("conflict", "Computer Use 令牌尚未绑定到运行中的任务");
    }
    const task = await this.tasks.get(token.taskId);
    if (!task) throw new PersistenceError("not_found", "任务不存在");
    if (!statuses.includes(task.status)) {
      throw new PersistenceError("conflict", `任务状态 ${task.status} 不允许 Computer Use 动作`);
    }
    const worker = await this.db
      .selectFrom("workers")
      .select(["id", "vm_id", "status", "current_task_id"])
      .where("id", "=", token.workerId)
      .executeTakeFirst();
    if (!worker) throw new PersistenceError("not_found", "Worker 不存在");
    if (worker.status !== "running" || worker.current_task_id !== task.id) {
      throw new PersistenceError("conflict", "Worker 不在执行该任务");
    }
    if (task.vmId !== token.vmId || worker.vm_id !== token.vmId) {
      throw new PersistenceError("conflict", "Worker/任务/令牌的 VM 不一致");
    }
    const vm = await this.db
      .selectFrom("vm_instances")
      .select(["power_state", "storage_root"])
      .where("id", "=", token.vmId)
      .executeTakeFirst();
    if (!vm) throw new PersistenceError("not_found", "VM 不存在");
    if (vm.power_state !== "running") {
      throw new PersistenceError("conflict", "目标 VM 未运行；不会重放旧桌面动作");
    }
    const lease = await this.activeLease(token.vmId);
    if (!lease || lease.owner !== "worker" || lease.taskId !== task.id) {
      throw new PersistenceError("lease_conflict", "任务没有有效的 Worker Execution Lease");
    }
    return {
      task,
      workerId: worker.id,
      vmId: token.vmId,
      projectId: task.projectId,
      storageRoot: vm.storage_root,
      leaseId: lease.id,
    };
  }

  private async activeLease(vmId: string) {
    const lease = await this.leaseRepository.getByVm(vmId);
    if (!lease) return undefined;
    return new Date(lease.expiresAt).getTime() > this.now().getTime() ? lease : undefined;
  }

  private async display(
    vmId: string,
  ): Promise<{ width: number; height: number; dpi: number | null; scaleFactor: number | null }> {
    const desktop = await this.guest.desktop(vmId);
    return {
      width: desktop.width,
      height: desktop.height,
      dpi: desktop.dpi ?? null,
      scaleFactor: desktop.scaleFactor ?? null,
    };
  }

  private async convertAction(
    action: ComputerAction,
    binding: TaskBinding,
    source: CuaScreenshotRecord | null,
  ): Promise<ComputerAction> {
    if (!source) return action;
    return convertComputerActionCoordinates(action, source.width, source.height);
  }

  private async screenshotRecord(
    taskId: string,
    screenshotId: string,
  ): Promise<CuaScreenshotRecord> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(screenshotId)) {
      throw new PersistenceError("validation_failed", "截图引用格式无效");
    }
    const row = await this.db
      .selectFrom("cua_screenshots")
      .selectAll()
      .where("id", "=", screenshotId)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!row) throw new PersistenceError("not_found", "截图不存在或不属于该任务");
    return toScreenshotRecord(row);
  }

  private async latestScreenshot(taskId: string): Promise<CuaScreenshotRecord | undefined> {
    const row = await this.db
      .selectFrom("cua_screenshots")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy(sql`rowid`, "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toScreenshotRecord(row) : undefined;
  }

  private async storeScreenshot(
    binding: TaskBinding,
    kind: CuaScreenshotKind,
    dataBase64: string,
    width: number,
    height: number,
    dpi: number | null,
    scaleFactor: number | null,
  ): Promise<CuaScreenshotRecord> {
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 * 1024) {
      throw new PersistenceError("validation_failed", "截图数据为空或超过大小限制");
    }
    const id = `${kind}-${randomUUID()}`;
    const directory = path.join(binding.storageRoot, "trace", binding.task.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${id}.png`);
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const capturedAt = this.now().toISOString();
    await this.db
      .insertInto("cua_screenshots")
      .values({
        id,
        task_id: binding.task.id,
        worker_id: binding.workerId,
        vm_id: binding.vmId,
        kind,
        width,
        height,
        dpi,
        scale_factor: scaleFactor,
        sha256,
        file_path: filePath,
        size_bytes: bytes.byteLength,
        captured_at: capturedAt,
      })
      .execute();
    return {
      id,
      taskId: binding.task.id,
      workerId: binding.workerId,
      vmId: binding.vmId,
      kind,
      width,
      height,
      dpi,
      scaleFactor,
      sha256,
      sizeBytes: bytes.byteLength,
      capturedAt,
    };
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.taskLocks.set(taskId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === tail) this.taskLocks.delete(taskId);
    }
  }
}

interface ActionRow {
  id: string;
  type: ComputerActionType;
  beforeScreenshotId: string | null;
  status: CuaActionStatus;
}

function validateActionId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && value.length <= 128 ? value : null;
}

function toGuestAction(action: ComputerAction): GuestInputAction {
  const {
    screenshotId: _screenshotId,
    coordinateSpace: _coordinateSpace,
    ...rest
  } = action as ComputerAction & {
    screenshotId?: string;
    coordinateSpace?: string;
  };
  void _screenshotId;
  void _coordinateSpace;
  return rest as unknown as GuestInputAction;
}

function approvalSummary(task: TaskRecord, action: ComputerAction): string {
  let detail: string = action.type;
  if (action.type === "type_text")
    detail = `type_text(${JSON.stringify(action.text.slice(0, 80))})`;
  if (action.type === "keypress") detail = `keypress(${action.keys.join("+")})`;
  if (action.type === "click" || action.type === "move") {
    detail = `${action.type}(${action.point.x},${action.point.y})`;
  }
  if (action.type === "drag") {
    detail = `drag(${action.from.x},${action.from.y} -> ${action.to.x},${action.to.y})`;
  }
  return `任务「${task.objective.slice(0, 120)}」请求执行 ${detail}`.slice(0, 1000);
}

function validateCompletion(input: CuaCompleteRequest, policy: CuaPolicy): string | null {
  if (typeof input !== "object" || input === null) return "完成请求必须是对象";
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary || summary.length > 4000) return "完成摘要必须为 1～4000 个字符";
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 8) {
    return "完成必须包含 1～8 项独立证据";
  }
  if (!policy.credentials.allowInGuest && /api[_-]?key|secret|password/i.test(summary)) {
    return "完成摘要不得包含凭据信息";
  }
  for (const item of input.evidence) {
    if (typeof item !== "object" || item === null) return "证据项必须是对象";
    if (item.type === "screenshot") {
      if (typeof item.screenshotId !== "string" || !item.screenshotId)
        return "截图证据缺少 screenshotId";
      continue;
    }
    if (item.type === "file") {
      if (!isSafeAbsoluteGuestPath(item.path))
        return "文件证据必须使用安全的绝对 POSIX 或 Windows Guest 路径";
      if (item.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(item.sha256))
        return "文件证据 SHA-256 无效";
      if (
        item.sizeBytes !== undefined &&
        (!Number.isInteger(item.sizeBytes) || item.sizeBytes < 0)
      ) {
        return "文件证据大小无效";
      }
      continue;
    }
    if (item.type === "process") {
      if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 64) {
        return "进程证据名称无效";
      }
      continue;
    }
    return `不支持的证据类型：${String((item as { type?: unknown }).type)}`;
  }
  return null;
}

function pathAllowed(candidate: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  return roots.some((root) => guestPathEqualsOrWithin(candidate, root));
}

const HUMAN_REQUIRED_GUEST_CODES = new Set(["session_locked", "secure_desktop"]);

function isHumanRequiredGuestError(error: unknown): boolean {
  return (
    error instanceof PersistenceError &&
    typeof error.details === "object" &&
    error.details !== null &&
    HUMAN_REQUIRED_GUEST_CODES.has(
      String((error.details as { guestCode?: unknown }).guestCode ?? ""),
    )
  );
}

function toScreenshotRecord(row: {
  id: string;
  task_id: string;
  worker_id: string;
  vm_id: string;
  kind: string;
  width: number;
  height: number;
  dpi: number | null;
  scale_factor: number | null;
  sha256: string;
  size_bytes: number;
  captured_at: string;
}): CuaScreenshotRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    vmId: row.vm_id,
    kind: row.kind as CuaScreenshotKind,
    width: row.width,
    height: row.height,
    dpi: row.dpi,
    scaleFactor: row.scale_factor,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    capturedAt: row.captured_at,
  };
}

function toActionRecord(row: {
  id: string;
  task_id: string;
  worker_id: string;
  vm_id: string;
  lease_id: string;
  action_type: string;
  action_json: string;
  source_screenshot_id: string | null;
  before_screenshot_id: string | null;
  after_screenshot_id: string | null;
  display_json: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  approval_id: string | null;
  created_at: string;
  executed_at: string | null;
  duration_ms: number | null;
}): CuaActionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    vmId: row.vm_id,
    leaseId: row.lease_id,
    type: row.action_type as ComputerActionType,
    action: safeJson(row.action_json),
    sourceScreenshotId: row.source_screenshot_id,
    beforeScreenshotId: row.before_screenshot_id,
    afterScreenshotId: row.after_screenshot_id,
    display: safeJson(row.display_json) as CuaActionRecord["display"],
    status: row.status as CuaActionStatus,
    result: row.result_json ? safeJson(row.result_json) : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    durationMs: row.duration_ms,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
