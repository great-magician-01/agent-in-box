import type { TaskStatus, WorkerStatus } from "@agent-in-box/protocol";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  created: "已创建",
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

export const WORKER_STATUS_LABELS: Record<WorkerStatus, string> = {
  starting: "启动中",
  running: "执行中",
  idle: "空闲",
  archiving: "归档中",
  archived: "已归档",
  restoring: "恢复中",
  failed: "异常",
};

export function taskStatusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "blocked":
      return "warning";
    case "waiting_approval":
    case "waiting_human":
      return "warning";
    case "waiting_resources":
    case "waiting_vm":
    case "queued":
      return "info";
    default:
      return "neutral";
  }
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
