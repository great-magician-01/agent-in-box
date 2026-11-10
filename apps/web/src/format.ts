import type {
  ControlPlaneState,
  DataRootSource,
  HostCheckStatus,
  StorageCategory,
} from "@agent-in-box/protocol";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

export function parseGb(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * 1024 * 1024 * 1024);
}

export const HOST_CHECK_STATUS_LABELS: Record<HostCheckStatus, string> = {
  ok: "通过",
  warning: "警告",
  error: "不通过",
  unknown: "未知",
};

export const STORAGE_CATEGORY_LABELS: Record<StorageCategory, string> = {
  images: "镜像",
  downloads: "下载缓存",
  vms: "虚拟机磁盘",
  snapshots: "快照",
  artifacts: "任务产物",
  archives: "归档",
};

export const DATA_ROOT_SOURCE_LABELS: Record<DataRootSource, string> = {
  environment: "由环境变量管理",
  config: "用户选择的目录",
  default: "系统默认目录",
};

export const CONTROL_PLANE_STATE_LABELS: Record<ControlPlaneState, string> = {
  starting: "启动中",
  running: "运行中",
  external: "外部进程",
  stopping: "停止中",
  stopped: "已停止",
  failed: "异常",
};
