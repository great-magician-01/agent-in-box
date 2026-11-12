import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Injectable } from "@nestjs/common";
import type { HostInspectionReport } from "@agent-in-box/protocol";
import { DatabaseService } from "../persistence/database.service";
import { diskSpace, readTextIfExists } from "../storage/fs-utils";
import {
  buildHostInspection,
  cpuVirtualizationFromInfo,
  parseWindowsVirtualizationOutput,
  type HostProbeSnapshot,
  type VirtualizationDetection,
} from "./host-inspection";

const execFileAsync = promisify(execFile);

const WINDOWS_VIRTUALIZATION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$cs = Get-CimInstance -ClassName Win32_ComputerSystem",
  "$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1",
  "Write-Output ('HypervisorPresent=' + $cs.HypervisorPresent)",
  "Write-Output ('VirtualizationFirmwareEnabled=' + $cpu.VirtualizationFirmwareEnabled)",
].join("; ");

interface VirtualizationProbe {
  detection: VirtualizationDetection;
  message: string;
  details?: Record<string, string>;
  isWsl2: boolean;
}

async function probeLinuxVirtualization(): Promise<VirtualizationProbe> {
  const [cpuInfo, procVersion] = await Promise.all([
    readTextIfExists("/proc/cpuinfo"),
    readTextIfExists("/proc/version"),
  ]);
  const isWsl2 = /microsoft/i.test(procVersion ?? "");
  const detection = cpuVirtualizationFromInfo(cpuInfo ?? "");

  if (detection === "detected") {
    return {
      detection,
      isWsl2,
      message: "检测到 CPU 虚拟化标志（VT-x/AMD-V）",
      details: isWsl2 ? { wsl2: "true" } : {},
    };
  }
  if (isWsl2) {
    return {
      detection: "unknown",
      isWsl2,
      message:
        "WSL2 内的 CPU 虚拟化由 Windows 管理，当前无法替代 Windows 宿主机 WHPX 检测；请在目标 Windows 上重新检查。",
      details: { wsl2: "true" },
    };
  }
  return {
    detection: "missing",
    isWsl2,
    message: "未检测到 CPU 虚拟化标志（VT-x/AMD-V）",
  };
}

async function probeWindowsVirtualization(): Promise<VirtualizationProbe> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_VIRTUALIZATION_SCRIPT,
      ],
      { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    const parsed = parseWindowsVirtualizationOutput(stdout);
    if (parsed.detection === "detected") {
      return {
        detection: "detected",
        isWsl2: false,
        message: "检测到 CPU 虚拟化（VT-x/AMD-V）或已启用的 Windows Hypervisor",
        details: parsed.details,
      };
    }
    if (parsed.detection === "missing") {
      return {
        detection: "missing",
        isWsl2: false,
        message:
          "未检测到 CPU 虚拟化。请在 BIOS/UEFI 启用 VT-x/AMD-V，并在 Windows 中启用虚拟机平台/Windows Hypervisor Platform。",
        details: parsed.details,
      };
    }
    return {
      detection: "unknown",
      isWsl2: false,
      message: "无法从 Windows 读取 CPU 虚拟化状态，请手动确认固件虚拟化与 WHPX 已启用。",
      details: parsed.details,
    };
  } catch (error) {
    return {
      detection: "unknown",
      isWsl2: false,
      message: `无法执行 Windows 虚拟化检查：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

@Injectable()
export class HostInspectionService {
  constructor(private readonly database: DatabaseService) {}

  async inspect(dataRoot?: string): Promise<HostInspectionReport> {
    const platform = process.platform;
    const resolvedDataRoot = path.resolve(dataRoot?.trim() || this.database.dataRoot);

    const virtualization: VirtualizationProbe =
      platform === "win32"
        ? await probeWindowsVirtualization()
        : platform === "linux"
          ? await probeLinuxVirtualization()
          : {
              detection: "unknown" as const,
              message: "当前平台未实现 CPU 虚拟化检测",
              isWsl2: false,
            };

    const disk = await diskSpace(resolvedDataRoot);
    const snapshot: HostProbeSnapshot = {
      platform,
      release: os.release(),
      architecture: process.arch,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      dataRoot: resolvedDataRoot,
      freeDiskBytes: disk.freeBytes,
      virtualization: virtualization.detection,
      virtualizationMessage: virtualization.message,
      ...(virtualization.details ? { virtualizationDetails: virtualization.details } : {}),
      isWsl2: virtualization.isWsl2,
    };

    return buildHostInspection(snapshot);
  }
}
