import type { NotificationKind, NotificationSeverity, TaskStatus } from "@agent-in-box/protocol";

export interface NotificationTaskContext {
  id: string;
  projectId: string;
  vmId: string;
  objective: string;
  status: TaskStatus;
  latestSummary: string | null;
  errorMessage: string | null;
}

export interface NotificationCandidate {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  projectId: string | null;
  taskId: string | null;
  vmId: string | null;
  workerId: string | null;
}

const TASK_STATUS_LABELS: Partial<Record<TaskStatus, string>> = {
  waiting_resources: "等待本机资源",
  waiting_vm: "等待虚拟机启动",
  queued: "排队中",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_human: "等待人工处理",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function taskFromPayload(payload: Record<string, unknown>): NotificationTaskContext | null {
  const task = record(payload.task);
  if (!task) return null;
  const id = text(task.id);
  const projectId = text(task.projectId);
  const vmId = text(task.vmId);
  const objective = text(task.objective);
  const status = text(task.status);
  if (!id || !projectId || !vmId || !objective || !status) return null;
  return {
    id,
    projectId,
    vmId,
    objective,
    status: status as TaskStatus,
    latestSummary: text(task.latestSummary),
    errorMessage: text(task.errorMessage),
  };
}

/**
 * Pure mapping from durable Outbox topics to user-facing notifications. The
 * notification center is a projection only; it never becomes a task store.
 */
export function notificationForEvent(
  topic: string,
  payload: unknown,
  taskContext: NotificationTaskContext | null = null,
): NotificationCandidate | null {
  const input = record(payload) ?? {};
  const payloadTask = taskFromPayload(input);
  const task = payloadTask ?? taskContext;
  const taskId = text(input.taskId) ?? task?.id ?? null;
  const projectId = text(input.projectId) ?? task?.projectId ?? null;
  const vmId = text(input.vmId) ?? task?.vmId ?? null;
  const workerId = text(input.workerId) ?? null;

  switch (topic) {
    case "task.created": {
      if (!task) return null;
      return {
        kind: "task",
        severity: "info",
        title: `新任务：${truncate(task.objective, 60)}`,
        body: `任务 ${task.id} 已创建，当前状态：${TASK_STATUS_LABELS[task.status] ?? task.status}。`,
        projectId: task.projectId,
        taskId: task.id,
        vmId: task.vmId,
        workerId,
      };
    }
    case "task.status_changed": {
      const to = text(input.to) as TaskStatus | null;
      if (!to || !task) return null;
      const detail = task.latestSummary ?? task.errorMessage ?? "";
      const labels: Partial<Record<TaskStatus, [NotificationSeverity, string]>> = {
        completed: ["success", "任务完成"],
        failed: ["danger", "任务失败"],
        blocked: ["warning", "任务阻塞"],
        cancelled: ["warning", "任务已取消"],
        waiting_resources: ["warning", "任务等待本机资源"],
        waiting_vm: ["info", "任务等待虚拟机启动"],
      };
      const entry = labels[to];
      if (!entry) return null;
      return {
        kind: "task",
        severity: entry[0],
        title: `${entry[1]}：${truncate(task.objective, 60)}`,
        body: detail ? truncate(detail, 400) : `任务 ${task.id} 状态变为 ${to}。`,
        projectId: task.projectId,
        taskId: task.id,
        vmId: task.vmId,
        workerId,
      };
    }
    case "task.approval_requested": {
      const actionType = text(input.actionType) ?? "敏感动作";
      const summary = text(input.summary) ?? "执行器请求人工确认。";
      return {
        kind: "approval",
        severity: "warning",
        title: `需要审批：${actionType}`,
        body: truncate(summary, 400),
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "task.human_verification_requested": {
      const reason = text(input.reason) ?? "Worker 请求人工完成当前验证。";
      return {
        kind: "task",
        severity: "warning",
        title: "任务需要人工处理",
        body: truncate(reason, 400),
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "task.human_verification_resolved": {
      const note = text(input.note);
      const resolvedBy = text(input.resolvedBy) ?? "local-user";
      return {
        kind: "task",
        severity: "info",
        title: "人工处理已完成",
        body: `任务 ${taskId ?? ""} 的人工处理已由 ${resolvedBy} 确认${note ? `：${truncate(note, 300)}` : "。"}`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "task.approval_resolved": {
      const status = text(input.status) ?? "resolved";
      const note = text(input.note);
      return {
        kind: "approval",
        severity: status === "approved" ? "success" : "info",
        title: status === "approved" ? "审批已批准" : "审批已拒绝或超时",
        body: `审批 ${text(input.approvalId) ?? ""} 已处理${note ? `：${truncate(note, 300)}` : "。"}`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "worker.archived":
      return {
        kind: "worker",
        severity: "info",
        title: "Worker 已归档",
        body: `Worker ${text(input.workerId) ?? ""} 已归档，可随时恢复。`,
        projectId,
        taskId,
        vmId,
        workerId: text(input.workerId) ?? workerId,
      };
    case "worker.resumed":
      return {
        kind: "worker",
        severity: "info",
        title: "Worker 已恢复",
        body: `Worker ${text(input.workerId) ?? ""} 已恢复（${text(input.restoreMode) ?? "auto"}）。`,
        projectId,
        taskId,
        vmId,
        workerId: text(input.workerId) ?? workerId,
      };
    case "vm.power_changed": {
      const to = text(input.to);
      if (to !== "error") return null;
      return {
        kind: "vm",
        severity: "danger",
        title: "虚拟机状态异常",
        body: `虚拟机 ${vmId ?? ""} 进入错误状态，请打开 VM 页面查看诊断。`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "resource.waiting_for_memory": {
      const names = Array.isArray(input.taskIds) ? input.taskIds.length : 0;
      return {
        kind: "resource",
        severity: "warning",
        title: "资源不足，任务等待中",
        body: `虚拟机 ${text(input.vmName) ?? text(input.vmId) ?? ""} 无法启动：${truncate(
          text(input.reason) ?? "宿主内存不足",
          300,
        )}${names > 0 ? `；${names} 个任务已进入等待。` : ""}`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "resource.vm_auto_started":
      return {
        kind: "resource",
        severity: "info",
        title: "虚拟机已自动启动",
        body: `为执行排队任务自动启动了虚拟机 ${text(input.vmName) ?? vmId ?? ""}。`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    case "resource.vm_idle_suspended":
      return {
        kind: "resource",
        severity: "info",
        title: "虚拟机已空闲休眠",
        body: `虚拟机 ${text(input.vmName) ?? vmId ?? ""} 因空闲自动休眠；不会影响运行中的任务。`,
        projectId,
        taskId,
        vmId,
        workerId,
      };
    case "router.status_changed": {
      const status = text(input.status);
      if (status !== "failed") return null;
      return {
        kind: "router",
        severity: "danger",
        title: "Router 回合失败",
        body: truncate(text(input.error) ?? "Router 执行失败，请查看主会话。", 400),
        projectId,
        taskId,
        vmId,
        workerId,
      };
    }
    case "bot.disconnected":
      return {
        kind: "bot",
        severity: "warning",
        title: "机器人连接断开",
        body: `${text(input.platform) ?? "平台"} 连接断开：${truncate(text(input.reason) ?? "未知原因", 300)}`,
        projectId,
        taskId: null,
        vmId: null,
        workerId: null,
      };
    case "bot.ingress_failed":
      return {
        kind: "bot",
        severity: "danger",
        title: "机器人消息处理失败",
        body: truncate(text(input.error) ?? "机器人事件处理失败", 400),
        projectId,
        taskId: null,
        vmId: null,
        workerId: null,
      };
    default:
      return null;
  }
}

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}
