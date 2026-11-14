import { describe, expect, it, vi } from "vitest";
import {
  buildHostInspection,
  cpuVirtualizationFromInfo,
  parseWindowsVirtualizationOutput,
  type HostProbeSnapshot,
} from "./host-inspection";
import { probeWindowsVirtualization } from "./host-inspection.service";

const GIB = 1024 * 1024 * 1024;

function probe(overrides: Partial<HostProbeSnapshot> = {}): HostProbeSnapshot {
  return {
    platform: "win32",
    release: "10.0.26100",
    architecture: "x64",
    totalMemoryBytes: 16 * GIB,
    freeMemoryBytes: 8 * GIB,
    dataRoot: "C:\\AgentInBox",
    freeDiskBytes: 100 * GIB,
    virtualization: "detected",
    virtualizationMessage: "检测到 CPU 虚拟化",
    isWsl2: false,
    ...overrides,
  };
}

describe("host inspection", () => {
  it("accepts a Windows host with virtualization and enough resources", () => {
    const report = buildHostInspection(probe(), undefined, new Date("2026-11-10T00:00:00.000Z"));

    expect(report.ready).toBe(true);
    expect(report.supported).toBe(true);
    expect(report.recommendedProvider).toBe("qemu-whpx");
    expect(report.checks.map((check) => check.id)).toEqual([
      "os",
      "cpu_virtualization",
      "memory",
      "disk",
    ]);
    expect(report.inspectedAt).toBe("2026-11-10T00:00:00.000Z");
  });

  it("rejects unsupported Windows versions", () => {
    const report = buildHostInspection(probe({ release: "6.1.7601" }));

    expect(report.ready).toBe(false);
    expect(report.supported).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "os", status: "error" });
  });

  it("treats an unknown virtualization state as blocking, never as ready", () => {
    const report = buildHostInspection(
      probe({ virtualization: "unknown", virtualizationMessage: "无法确认" }),
    );

    expect(report.ready).toBe(false);
    expect(report.recommendedProvider).toBeNull();
    expect(report.checks.find((check) => check.id === "cpu_virtualization")?.status).toBe("error");
  });

  it("allows warnings while blocking errors", () => {
    const warning = buildHostInspection(
      probe({ totalMemoryBytes: 6 * GIB, freeDiskBytes: 20 * GIB }),
    );
    expect(warning.ready).toBe(true);
    expect(warning.checks.find((check) => check.id === "memory")?.status).toBe("warning");
    expect(warning.checks.find((check) => check.id === "disk")?.status).toBe("warning");

    const lowMemory = buildHostInspection(probe({ totalMemoryBytes: 2 * GIB }));
    expect(lowMemory.ready).toBe(false);
    expect(lowMemory.checks.find((check) => check.id === "memory")?.status).toBe("error");

    const lowDisk = buildHostInspection(probe({ freeDiskBytes: 4 * GIB }));
    expect(lowDisk.ready).toBe(false);
    expect(lowDisk.checks.find((check) => check.id === "disk")?.status).toBe("error");
  });

  it("marks WSL2 as a development warning, not a Windows validation", () => {
    const report = buildHostInspection(
      probe({ platform: "linux", release: "6.6.0-microsoft-standard-WSL2", isWsl2: true }),
    );

    expect(report.ready).toBe(true);
    expect(report.recommendedProvider).toBe("qemu-kvm");
    expect(report.checks[0]).toMatchObject({ id: "os", status: "warning" });
    expect(report.checks[0]?.message).toContain("WSL2");
  });

  it("detects KVM/virtualization flags and parses PowerShell output", () => {
    expect(cpuVirtualizationFromInfo("flags\t\t: fpu vme vmx ssse3\n")).toBe("detected");
    expect(cpuVirtualizationFromInfo("flags\t\t: fpu vme svm\n")).toBe("detected");
    expect(cpuVirtualizationFromInfo("flags\t\t: fpu vme\n")).toBe("missing");

    expect(
      parseWindowsVirtualizationOutput(
        "HypervisorPresent=True\r\nVirtualizationFirmwareEnabled=False\r\n",
      ),
    ).toEqual({
      detection: "detected",
      details: { hypervisorPresent: "true", virtualizationFirmwareEnabled: "false" },
    });
    expect(
      parseWindowsVirtualizationOutput(
        "HypervisorPresent=False\r\nVirtualizationFirmwareEnabled=False\r\n",
      ).detection,
    ).toBe("missing");
    expect(parseWindowsVirtualizationOutput("garbage").detection).toBe("unknown");
  });

  it("falls back to WMI when the Windows CIM query fails", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("CIM unavailable"))
      .mockResolvedValueOnce("HypervisorPresent=True\r\nVirtualizationFirmwareEnabled=False\r\n");

    const result = await probeWindowsVirtualization(run);

    expect(result.detection).toBe("detected");
    expect(result.details).toMatchObject({ hypervisorPresent: "true" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1].at(-1)).toContain("Get-WmiObject");
  });

  it("uses systeminfo when both PowerShell query APIs fail", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("CIM unavailable"))
      .mockRejectedValueOnce(new Error("WMI unavailable"))
      .mockResolvedValueOnce(
        "Hyper-V Requirements: A hypervisor has been detected. Features required for Hyper-V will not be displayed.",
      );

    const result = await probeWindowsVirtualization(run);

    expect(result.detection).toBe("detected");
    expect(result.details).toEqual({ source: "systeminfo", hypervisorPresent: "true" });
    expect(run).toHaveBeenNthCalledWith(3, "systeminfo.exe", ["/FO", "LIST"]);
  });

  it("keeps an explicit negative result authoritative and reports fallback stderr", async () => {
    const negative = await probeWindowsVirtualization(
      vi.fn().mockResolvedValue("HypervisorPresent=False\nVirtualizationFirmwareEnabled=False\n"),
    );
    expect(negative.detection).toBe("missing");

    const failure = new Error("command failed") as Error & { stderr: string };
    failure.stderr = "Access denied";
    const unknown = await probeWindowsVirtualization(vi.fn().mockRejectedValue(failure));
    expect(unknown.detection).toBe("unknown");
    expect(unknown.message).toContain("Access denied");
  });
});
