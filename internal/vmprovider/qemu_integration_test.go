package vmprovider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestQemuProviderIntegration runs the real QEMU provider against a real host.
// It is skipped by default; set AGENT_IN_BOX_QEMU_INTEGRATION=1 and provide the
// QEMU directory, base image and a disposable VM storage root.
func TestQemuProviderIntegration(t *testing.T) {
	if os.Getenv("AGENT_IN_BOX_QEMU_INTEGRATION") != "1" {
		t.Skip("set AGENT_IN_BOX_QEMU_INTEGRATION=1 to run the real hypervisor test")
	}
	qemuDir := os.Getenv("AGENT_IN_BOX_QEMU_DIR")
	baseImage := os.Getenv("AGENT_IN_BOX_BASE_IMAGE")
	storageRoot := os.Getenv("AGENT_IN_BOX_VM_STORAGE")
	if qemuDir == "" || baseImage == "" || storageRoot == "" {
		t.Fatal("AGENT_IN_BOX_QEMU_DIR, AGENT_IN_BOX_BASE_IMAGE and AGENT_IN_BOX_VM_STORAGE are required")
	}

	config := QemuConfig{
		SystemBinary: filepath.Join(qemuDir, "qemu-system-x86_64"),
		ImageBinary:  filepath.Join(qemuDir, "qemu-img"),
		StorageRoot:  storageRoot,
	}
	provider, err := NewQemuProvider(config)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()

	vmID := "go-provider-smoke"
	_ = provider.DeleteVm(ctx, vmID)
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Keep the directory and logs on failure for diagnosis; the next run
		// deletes the VM before recreating it.
		_, _ = provider.StopVm(cleanupCtx, vmID, "force")
	})

	state, err := provider.CreateVm(ctx, VmSpec{
		ID:            vmID,
		Name:          "Go provider integration",
		BaseImagePath: baseImage,
		SeedImagePath: os.Getenv("AGENT_IN_BOX_SEED_IMAGE"),
		CPUCount:      2,
		MemoryMB:      2048,
		DiskSizeGB:    20,
		Desktop:       true,
	})
	if err != nil {
		t.Fatalf("create vm: %v", err)
	}
	if state.PowerState != PowerStopped {
		t.Fatalf("new VM state: %+v", state)
	}

	state, err = provider.StartVm(ctx, vmID)
	if err != nil {
		t.Fatalf("start vm: %v", err)
	}
	if state.PowerState != PowerRunning || state.PID == 0 {
		t.Fatalf("start state: %+v", state)
	}
	originalPID := state.PID

	// Wait for the guest login prompt so ACPI shutdown is handled by the guest.
	loginDeadline := time.Now().Add(120 * time.Second)
	consolePath := filepath.Join(storageRoot, vmID, "console.log")
	for {
		data, _ := os.ReadFile(consolePath)
		if strings.Contains(string(data), "login:") {
			break
		}
		if time.Now().After(loginDeadline) {
			t.Fatal("guest did not reach login prompt")
		}
		time.Sleep(2 * time.Second)
	}

	// A new provider instance has no in-memory process handles. This is the same
	// reconciliation path used after the supervisor process is restarted.
	restarted, err := NewQemuProvider(config)
	if err != nil {
		t.Fatal(err)
	}
	state, err = restarted.GetVmState(ctx, vmID)
	if err != nil {
		t.Fatalf("state after supervisor restart: %v", err)
	}
	if state.PowerState != PowerRunning || state.PID != originalPID {
		t.Fatalf("restart reconciliation failed: %+v, original pid %d", state, originalPID)
	}

	state, err = restarted.StartVm(ctx, vmID)
	if err != nil {
		t.Fatalf("idempotent start: %v", err)
	}
	if state.PID != originalPID {
		t.Fatalf("idempotent start launched a new process: old %d new %d", originalPID, state.PID)
	}

	state, err = restarted.SuspendVm(ctx, vmID)
	if err != nil || state.PowerState != PowerSuspended {
		t.Fatalf("suspend: %+v %v", state, err)
	}
	state, err = restarted.StartVm(ctx, vmID)
	if err != nil || state.PowerState != PowerSuspended {
		t.Fatalf("start must not hide suspended state: %+v %v", state, err)
	}
	state, err = restarted.ResumeVm(ctx, vmID)
	if err != nil || state.PowerState != PowerRunning || state.PID != originalPID {
		t.Fatalf("resume: %+v %v", state, err)
	}

	state, err = restarted.StopVm(ctx, vmID, "graceful")
	if err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
	if state.PowerState != PowerStopped {
		t.Fatalf("stop state: %+v", state)
	}
	state, err = restarted.StopVm(ctx, vmID, "graceful")
	if err != nil || state.PowerState != PowerStopped {
		t.Fatalf("idempotent stop: %+v %v", state, err)
	}

	if _, err := restarted.CreateSnapshot(ctx, vmID, "go-integration"); err != nil {
		t.Fatalf("create snapshot: %v", err)
	}
	if _, err := restarted.RestoreSnapshot(ctx, vmID, "go-integration"); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}
	if err := restarted.DeleteVm(ctx, vmID); err != nil {
		t.Fatalf("delete vm: %v", err)
	}
}
