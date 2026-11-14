import type {
  HostCheck,
  HostCheckStatus,
  HostInspectionReport,
  IsoTimestamp,
} from "@agent-in-box/protocol";

export type VirtualizationDetection = "detected" | "missing" | "unknown";

export interface HostProbeSnapshot {
  platform: NodeJS.Platform;
  release: string;
  architecture: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  dataRoot: string;
  freeDiskBytes: number;
  virtualization: VirtualizationDetection;
  virtualizationMessage: string;
  virtualizationDetails?: Record<string, string>;
  isWsl2: boolean;
}

export interface HostInspectionThresholds {
  minimumMemoryBytes: number;
  recommendedMemoryBytes: number;
  minimumDiskBytes: number;
  recommendedDiskBytes: number;
}

export const DEFAULT_HOST_THRESHOLDS: HostInspectionThresholds = {
  minimumMemoryBytes: 4 * 1024 * 1024 * 1024,
  recommendedMemoryBytes: 8 * 1024 * 1024 * 1024,
  minimumDiskBytes: 5 * 1024 * 1024 * 1024,
  recommendedDiskBytes: 30 * 1024 * 1024 * 1024,
};

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function inspectOperatingSystem(probe: HostProbeSnapshot): {
  check: HostCheck;
  supported: boolean;
} {
  if (probe.platform === "win32") {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(probe.release);
    const major = match ? Number(match[1]) : Number.NaN;
    const build = match?.[3] ? Number(match[3]) : 0;
    if (Number.isNaN(major) || major < 10) {
      return {
        supported: false,
        check: {
          id: "os",
          status: "error",
          message: `不支持的 Windows 版本（${probe.release}）；需要 Windows 10 或 Windows 11`,
        },
      };
    }
    if (build > 0 && build < 17763) {
      return {
        supported: false,
        check: {
          id: "os",
          status: "error",
          message: `Windows 版本过旧（build ${build}）；需要 Windows 10 1809 或更高版本`,
        },
      };
    }
    return {
      supported: true,
      check: {
        id: "os",
        status: "ok",
        message: `Windows ${probe.release}`,
        details: { release: probe.release },
      },
    };
  }

  if (probe.platform === "linux") {
    if (probe.isWsl2) {
      return {
        supported: true,
        check: {
          id: "os",
          status: "warning",
          message:
            "当前运行在 WSL2 中。可以开发和测试本地服务，但发布目标是 Windows 宿主机，Hypervisor 验证必须以 Windows 结果为准。",
          details: { wsl2: "true", release: probe.release },
        },
      };
    }
    return {
      supported: true,
      check: {
        id: "os",
        status: "ok",
        message: `Linux ${probe.release}`,
        details: { release: probe.release },
      },
    };
  }

  return {
    supported: false,
    check: {
      id: "os",
      status: "error",
      message: `首版仅支持 Windows 宿主机（${probe.platform} 未支持）`,
    },
  };
}

function inspectVirtualization(probe: HostProbeSnapshot): HostCheck {
  const status: HostCheckStatus =
    probe.virtualization === "detected"
      ? "ok"
      : probe.virtualization === "missing"
        ? "error"
        : "error";
  return {
    id: "cpu_virtualization",
    status,
    message: probe.virtualizationMessage,
    ...(probe.virtualizationDetails ? { details: probe.virtualizationDetails } : {}),
  };
}

function inspectMemory(probe: HostProbeSnapshot, thresholds: HostInspectionThresholds): HostCheck {
  if (probe.totalMemoryBytes <= 0) {
    return {
      id: "memory",
      status: "error",
      message: "无法读取宿主机物理内存",
    };
  }
  if (probe.totalMemoryBytes < thresholds.minimumMemoryBytes) {
    return {
      id: "memory",
      status: "error",
      message: `物理内存 ${formatGiB(probe.totalMemoryBytes)} 低于最低要求 ${formatGiB(
        thresholds.minimumMemoryBytes,
      )}`,
    };
  }
  if (probe.totalMemoryBytes < thresholds.recommendedMemoryBytes) {
    return {
      id: "memory",
      status: "warning",
      message: `物理内存 ${formatGiB(probe.totalMemoryBytes)} 低于建议值 ${formatGiB(
        thresholds.recommendedMemoryBytes,
      )}，桌面 VM 可能需要等待资源`,
      details: { totalMemoryBytes: String(probe.totalMemoryBytes) },
    };
  }
  return {
    id: "memory",
    status: "ok",
    message: `物理内存 ${formatGiB(probe.totalMemoryBytes)}`,
    details: {
      totalMemoryBytes: String(probe.totalMemoryBytes),
      freeMemoryBytes: String(probe.freeMemoryBytes),
    },
  };
}

function inspectDisk(probe: HostProbeSnapshot, thresholds: HostInspectionThresholds): HostCheck {
  if (probe.freeDiskBytes <= 0) {
    return {
      id: "disk",
      status: "error",
      message: "无法读取存储目录所在磁盘的可用空间",
      details: { dataRoot: probe.dataRoot },
    };
  }
  if (probe.freeDiskBytes < thresholds.minimumDiskBytes) {
    return {
      id: "disk",
      status: "error",
      message: `存储目录可用空间 ${formatGiB(probe.freeDiskBytes)} 低于最低要求 ${formatGiB(
        thresholds.minimumDiskBytes,
      )}`,
      details: { dataRoot: probe.dataRoot, freeDiskBytes: String(probe.freeDiskBytes) },
    };
  }
  if (probe.freeDiskBytes < thresholds.recommendedDiskBytes) {
    return {
      id: "disk",
      status: "warning",
      message: `存储目录可用空间 ${formatGiB(probe.freeDiskBytes)} 低于建议值 ${formatGiB(
        thresholds.recommendedDiskBytes,
      )}`,
      details: { dataRoot: probe.dataRoot, freeDiskBytes: String(probe.freeDiskBytes) },
    };
  }
  return {
    id: "disk",
    status: "ok",
    message: `存储目录可用空间 ${formatGiB(probe.freeDiskBytes)}`,
    details: { dataRoot: probe.dataRoot, freeDiskBytes: String(probe.freeDiskBytes) },
  };
}

export function buildHostInspection(
  probe: HostProbeSnapshot,
  thresholds: HostInspectionThresholds = DEFAULT_HOST_THRESHOLDS,
  now: Date = new Date(),
): HostInspectionReport {
  const operatingSystem = inspectOperatingSystem(probe);
  const checks: HostCheck[] = [
    operatingSystem.check,
    inspectVirtualization(probe),
    inspectMemory(probe, thresholds),
    inspectDisk(probe, thresholds),
  ];
  const ready = checks.every((check) => check.status !== "error");
  const recommendedProvider = ready
    ? probe.platform === "win32"
      ? "qemu-whpx"
      : probe.platform === "linux"
        ? "qemu-kvm"
        : null
    : null;

  return {
    platform: probe.platform,
    release: probe.release,
    architecture: probe.architecture,
    supported: operatingSystem.supported,
    totalMemoryBytes: probe.totalMemoryBytes,
    freeMemoryBytes: probe.freeMemoryBytes,
    dataRoot: probe.dataRoot,
    freeDiskBytes: probe.freeDiskBytes,
    ready,
    recommendedProvider,
    checks,
    inspectedAt: now.toISOString() as IsoTimestamp,
  };
}

export function cpuVirtualizationFromInfo(cpuInfo: string): VirtualizationDetection {
  for (const line of cpuInfo.split("\n")) {
    if (!line.startsWith("flags") && !line.startsWith("Features")) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.includes("vmx") || fields.includes("svm")) {
      return "detected";
    }
  }
  return "missing";
}

export function parseWindowsSystemInfoOutput(output: string): {
  detection: VirtualizationDetection;
  details: Record<string, string>;
} {
  if (/a hypervisor (?:has been|is) detected|检测到(?:虚拟机监控程序|hypervisor)/i.test(output)) {
    return {
      detection: "detected",
      details: { source: "systeminfo", hypervisorPresent: "true" },
    };
  }
  return { detection: "unknown", details: { source: "systeminfo" } };
}

export function parseWindowsVirtualizationOutput(output: string): {
  detection: VirtualizationDetection;
  details: Record<string, string>;
} {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]+)\s*=\s*(\S+)/.exec(line.trim());
    if (match?.[1] && match[2]) {
      values.set(match[1].toLowerCase(), match[2].toLowerCase());
    }
  }

  const hypervisor = values.get("hypervisorpresent");
  const firmware = values.get("virtualizationfirmwareenabled");
  const details: Record<string, string> = {};
  if (hypervisor !== undefined) {
    details.hypervisorPresent = hypervisor;
  }
  if (firmware !== undefined) {
    details.virtualizationFirmwareEnabled = firmware;
  }

  if (hypervisor === "true" || firmware === "true") {
    return { detection: "detected", details };
  }
  if (hypervisor === "false" && firmware === "false") {
    return { detection: "missing", details };
  }
  return { detection: "unknown", details };
}
