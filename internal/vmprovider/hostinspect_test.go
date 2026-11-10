package vmprovider

import (
	"context"
	"runtime"
	"testing"
)

func TestAccelListed(t *testing.T) {
	output := "Accelerators supported in QEMU binary:\ntcg\nwhpx\n"
	if !accelListed(output, "whpx") || !accelListed(output, "tcg") {
		t.Fatalf("expected whpx and tcg in %q", output)
	}
	if accelListed(output, "kvm") {
		t.Fatal("kvm must not be reported from a Windows QEMU build")
	}
}

func TestCPUHasVirtualization(t *testing.T) {
	if !cpuHasVirtualization("flags\t\t: fpu vmx sse2") {
		t.Fatal("vmx not detected")
	}
	if !cpuHasVirtualization("flags\t\t: fpu svm sse2") {
		t.Fatal("svm not detected")
	}
	if cpuHasVirtualization("flags\t\t: fpu sse2") {
		t.Fatal("unexpected virtualization flag")
	}
	if cpuHasVirtualization("model name\t: vmx-like CPU") {
		t.Fatal("model name must not be parsed as flags")
	}
}

func TestInspectHostReturnsExplicitChecks(t *testing.T) {
	inspection := InspectHost(context.Background(), QemuConfig{StorageRoot: t.TempDir()})
	if inspection.Platform != runtime.GOOS {
		t.Fatalf("platform: %s", inspection.Platform)
	}
	ids := map[string]CheckStatus{}
	for _, check := range inspection.Checks {
		ids[check.ID] = check.Status
		if check.Status == "" || check.Message == "" {
			t.Fatalf("check must have explicit status and message: %+v", check)
		}
	}
	for _, required := range []string{"hardware_acceleration", "qemu_binary", "qemu_accelerator", "memory", "disk"} {
		if _, ok := ids[required]; !ok {
			t.Fatalf("missing check %s in %+v", required, inspection.Checks)
		}
	}
	if runtime.GOOS == "windows" {
		if _, ok := ids["hyperv_optional_feature"]; !ok {
			t.Fatal("Windows inspection must include Hyper-V feature state")
		}
	}
}
