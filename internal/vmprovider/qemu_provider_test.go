package vmprovider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateSpec(t *testing.T) {
	base := filepath.Join(t.TempDir(), "base.qcow2")
	if err := os.WriteFile(base, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	valid := VmSpec{ID: "vm-1", BaseImagePath: base, CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20}
	if err := validateSpec(valid); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}

	cases := []VmSpec{
		{ID: "../escape", BaseImagePath: base, CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20},
		{ID: "vm-1", CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20},
		{ID: "vm-1", BaseImagePath: base, CPUCount: 0, MemoryMB: 2048, DiskSizeGB: 20},
		{ID: "vm-1", BaseImagePath: base, CPUCount: 2, MemoryMB: 128, DiskSizeGB: 20},
		{ID: "vm-1", BaseImagePath: base, CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 0},
	}
	for index, spec := range cases {
		if err := validateSpec(spec); err == nil {
			t.Fatalf("case %d: expected validation error", index)
		}
	}
}

func TestBuildQemuArgs(t *testing.T) {
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID:            "vm-1",
			BaseImagePath: "/images/base.qcow2",
			SeedImagePath: "/vms/vm-1/seed.iso",
			CPUCount:      2,
			MemoryMB:      4096,
			Desktop:       true,
			QMPPort:       14445,
			SSHHostPort:   10023,
			VNCDisplay:    1,
		},
		State: VmState{DiskPath: "/vms/vm-1/disk.qcow2"},
	}
	args := strings.Join(buildQemuArgs(metadata, "whpx", "qemu64"), " ")
	for _, expected := range []string{
		"-accel whpx,kernel-irqchip=off",
		"-cpu qemu64",
		"-smp 2",
		"-m 4096",
		"-vga none",
		"virtio-gpu-pci",
		"virtio-tablet-pci",
		"hostfwd=tcp:127.0.0.1:10023-:22",
		"-vnc 127.0.0.1:1",
		"-qmp tcp:127.0.0.1:14445,server,nowait",
		"seed.iso,if=virtio,media=cdrom,format=raw,readonly=on",
	} {
		if !strings.Contains(args, expected) {
			t.Fatalf("args missing %q: %s", expected, args)
		}
	}
}

func TestQemuProviderCreateSnapshotAndDelete(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a shell fake for qemu-img")
	}
	root := t.TempDir()
	binaryDir := t.TempDir()
	logPath := filepath.Join(root, "qemu-img-args.log")
	fake := filepath.Join(binaryDir, "qemu-img")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"" + logPath + "\"\nif [ \"$1\" = create ]; then : > \"$8\"; fi\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, "base.qcow2")
	if err := os.WriteFile(base, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}

	provider, err := NewQemuProvider(QemuConfig{
		SystemBinary: "unused-qemu-system",
		ImageBinary:  fake,
		StorageRoot:  filepath.Join(root, "vms"),
		Accelerator:  "kvm",
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	state, err := provider.CreateVm(ctx, VmSpec{
		ID:            "vm-1",
		Name:          "Validation VM",
		BaseImagePath: base,
		CPUCount:      2,
		MemoryMB:      2048,
		DiskSizeGB:    20,
	})
	if err != nil {
		t.Fatalf("create vm: %v", err)
	}
	if state.PowerState != PowerStopped || state.QMPPort == 0 || state.SSHHostPort == 0 {
		t.Fatalf("unexpected state: %+v", state)
	}
	if _, err := os.Stat(state.DiskPath); err != nil {
		t.Fatalf("overlay not created: %v", err)
	}
	if _, err := provider.CreateVm(ctx, VmSpec{
		ID: "vm-1", BaseImagePath: base, CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20,
	}); err != ErrAlreadyExists {
		t.Fatalf("expected ErrAlreadyExists, got %v", err)
	}

	if _, err := provider.CreateSnapshot(ctx, "vm-1", "phase0"); err != nil {
		t.Fatalf("create snapshot: %v", err)
	}
	if _, err := provider.RestoreSnapshot(ctx, "vm-1", "phase0"); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}

	state, err = provider.GetVmState(ctx, "vm-1")
	if err != nil || state.PowerState != PowerStopped {
		t.Fatalf("get state: %+v %v", state, err)
	}
	console, err := provider.AttachConsole(ctx, "vm-1")
	if err != nil || !strings.HasPrefix(console, "vnc://127.0.0.1:") {
		t.Fatalf("console: %q %v", console, err)
	}

	if err := provider.DeleteVm(ctx, "vm-1"); err != nil {
		t.Fatalf("delete vm: %v", err)
	}
	if _, err := provider.GetVmState(ctx, "vm-1"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}

	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"create", "snapshot", "-c", "phase0", "-a"} {
		if !strings.Contains(string(logData), expected) {
			t.Fatalf("qemu-img log missing %q:\n%s", expected, logData)
		}
	}
}
