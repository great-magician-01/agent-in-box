package vmprovider

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// CheckStatus is deliberately explicit: unknown is not ready.
type CheckStatus string

const (
	CheckOK      CheckStatus = "ok"
	CheckWarning CheckStatus = "warning"
	CheckError   CheckStatus = "error"
	CheckUnknown CheckStatus = "unknown"
)

// HostCheck is one host capability result with an actionable message.
type HostCheck struct {
	ID      string            `json:"id"`
	Status  CheckStatus       `json:"status"`
	Message string            `json:"message"`
	Details map[string]string `json:"details,omitempty"`
}

// HostInspection is returned before any image download or VM creation.
type HostInspection struct {
	Platform            string      `json:"platform"`
	Architecture        string      `json:"architecture"`
	TotalMemoryBytes    uint64      `json:"totalMemoryBytes"`
	FreeDiskBytes       uint64      `json:"freeDiskBytes"`
	RecommendedProvider string      `json:"recommendedProvider"`
	Ready               bool        `json:"ready"`
	Checks              []HostCheck `json:"checks"`
}

func accelListed(helpOutput string, accelerator string) bool {
	for _, field := range strings.Fields(helpOutput) {
		if field == accelerator {
			return true
		}
	}
	return false
}

func cpuHasVirtualization(cpuInfo string) bool {
	for _, line := range strings.Split(cpuInfo, "\n") {
		if !strings.HasPrefix(line, "flags") && !strings.HasPrefix(line, "Features") {
			continue
		}
		for _, flag := range strings.Fields(line) {
			if flag == "vmx" || flag == "svm" {
				return true
			}
		}
	}
	return false
}

// InspectHost runs local, read-only checks. It never enables Windows features or
// changes services; unsupported systems get explicit errors instead of false Ready.
func InspectHost(ctx context.Context, config QemuConfig) HostInspection {
	if config.SystemBinary == "" {
		config.SystemBinary = "qemu-system-x86_64"
		if runtime.GOOS == "windows" {
			config.SystemBinary += ".exe"
		}
	}

	inspection := HostInspection{
		Platform:         runtime.GOOS,
		Architecture:     runtime.GOARCH,
		TotalMemoryBytes: totalPhysicalMemory(),
		FreeDiskBytes:    freeDiskBytes(config.StorageRoot),
		Checks:           []HostCheck{},
	}

	if runtime.GOOS == "linux" {
		cpuInfo, _ := readFileSafe("/proc/cpuinfo")
		status := CheckError
		message := "CPU virtualization flags (vmx/svm) were not detected"
		if cpuHasVirtualization(cpuInfo) {
			status = CheckOK
			message = "CPU virtualization flags detected"
		}
		inspection.Checks = append(inspection.Checks, HostCheck{ID: "cpu_virtualization", Status: status, Message: message})
	}

	acceleration := inspectAcceleration(config)
	inspection.Checks = append(inspection.Checks, acceleration)
	if runtime.GOOS == "windows" {
		inspection.Checks = append(inspection.Checks, HostCheck{
			ID:      "hyperv_optional_feature",
			Status:  CheckUnknown,
			Message: "Hyper-V feature state requires elevated inspection; the QEMU/WHPX path does not depend on Hyper-V Manager",
		})
	}

	qemuCheck := HostCheck{ID: "qemu_binary", Status: CheckError, Message: "QEMU executable not found"}
	binaryPath, err := exec.LookPath(config.SystemBinary)
	if err == nil {
		qemuCheck.Status = CheckOK
		qemuCheck.Message = binaryPath
		if output, err := exec.CommandContext(ctx, binaryPath, "--version").CombinedOutput(); err == nil {
			qemuCheck.Details = map[string]string{"version": strings.TrimSpace(strings.Split(string(output), "\n")[0])}
		}
	}
	inspection.Checks = append(inspection.Checks, qemuCheck)

	accelSupport := HostCheck{ID: "qemu_accelerator", Status: CheckUnknown, Message: "QEMU accelerator list not checked"}
	if err == nil {
		if output, err := exec.CommandContext(ctx, binaryPath, "-accel", "help").CombinedOutput(); err == nil {
			accelSupport.Message = strings.TrimSpace(string(output))
			accelSupport.Status = CheckError
			if runtime.GOOS == "windows" && accelListed(string(output), "whpx") {
				accelSupport.Status = CheckOK
			}
			if runtime.GOOS == "linux" && accelListed(string(output), "kvm") {
				accelSupport.Status = CheckOK
			}
		}
	}
	inspection.Checks = append(inspection.Checks, accelSupport)

	if inspection.TotalMemoryBytes > 0 && inspection.TotalMemoryBytes < 8*1024*1024*1024 {
		inspection.Checks = append(inspection.Checks, HostCheck{
			ID: "memory", Status: CheckWarning,
			Message: "Less than 8 GB physical memory; desktop VMs may need to wait for resources",
		})
	} else {
		inspection.Checks = append(inspection.Checks, HostCheck{ID: "memory", Status: CheckOK, Message: "Physical memory detected"})
	}

	if inspection.FreeDiskBytes > 0 && inspection.FreeDiskBytes < 30*1024*1024*1024 {
		inspection.Checks = append(inspection.Checks, HostCheck{
			ID: "disk", Status: CheckWarning,
			Message: "Less than 30 GB free disk space at the VM storage root",
		})
	} else {
		inspection.Checks = append(inspection.Checks, HostCheck{ID: "disk", Status: CheckOK, Message: "Disk space checked"})
	}

	inspection.Ready = true
	for _, check := range inspection.Checks {
		if check.Status == CheckError {
			inspection.Ready = false
		}
	}
	if inspection.Ready {
		switch runtime.GOOS {
		case "windows":
			inspection.RecommendedProvider = "qemu-whpx"
		case "linux":
			inspection.RecommendedProvider = "qemu-kvm"
		}
	}
	return inspection
}

func readFileSafe(path string) (string, error) {
	data, err := readFile(path)
	return string(data), err
}

func unavailableCheck(id string, err error) HostCheck {
	return HostCheck{ID: id, Status: CheckError, Message: fmt.Sprintf("%v", err)}
}
