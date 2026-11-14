package vmprovider

import (
	"context"
	"encoding/json"
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

func TestValidateSpecOsFamily(t *testing.T) {
	base := filepath.Join(t.TempDir(), "base.qcow2")
	if err := os.WriteFile(base, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, family := range []string{"", "linux", "Linux", "windows", "Windows"} {
		spec := VmSpec{
			ID: "vm-1", OsFamily: family, BaseImagePath: base,
			CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20,
		}
		if err := validateSpec(spec); err != nil {
			t.Fatalf("osFamily %q rejected: %v", family, err)
		}
	}
	spec := VmSpec{
		ID: "vm-1", OsFamily: "plan9", BaseImagePath: base,
		CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20,
	}
	if err := validateSpec(spec); err == nil {
		t.Fatal("unsupported osFamily was accepted")
	}
}

func TestBuildQemuArgsWindows(t *testing.T) {
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID:             "vm-win",
			OsFamily:       OsWindows,
			BaseImagePath:  "/images/windows.qcow2",
			SeedImagePath:  "/vms/vm-win/provision.iso",
			CPUCount:       4,
			MemoryMB:       8192,
			Desktop:        true,
			QMPPort:        14446,
			SSHHostPort:    10024,
			GuestHostPort:  17621,
			WorkerHostPort: 17622,
			VNCDisplay:     2,
		},
		State: VmState{DiskPath: "/vms/vm-win/disk.qcow2"},
	}
	qemuArgs, err := buildQemuArgs(metadata, "whpx", "qemu64")
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	args := strings.Join(qemuArgs, " ")
	for _, expected := range []string{
		"file=/vms/vm-win/disk.qcow2,if=ide,format=qcow2",
		"provision.iso,if=ide,media=cdrom,format=raw,readonly=on",
		"-cpu qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt",
		"-vga std",
		"qemu-xhci",
		"usb-tablet",
		"e1000,netdev=n0",
		"hostfwd=tcp:127.0.0.2:17621-:7611",
		"hostfwd=tcp:127.0.0.2:17622-:7612",
	} {
		if !strings.Contains(args, expected) {
			t.Fatalf("Windows args missing %q: %s", expected, args)
		}
	}
	for _, unexpected := range []string{"virtio-gpu-pci", "virtio-tablet-pci", "virtio-net-pci", "if=virtio"} {
		if strings.Contains(args, unexpected) {
			t.Fatalf("Windows args must not contain %q: %s", unexpected, args)
		}
	}
}

func TestBuildQemuArgs(t *testing.T) {
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID:             "vm-1",
			BaseImagePath:  "/images/base.qcow2",
			SeedImagePath:  "/vms/vm-1/seed.iso",
			CPUCount:       2,
			MemoryMB:       4096,
			Desktop:        true,
			QMPPort:        14445,
			SSHHostPort:    10023,
			GuestHostPort:  17611,
			WorkerHostPort: 17612,
			VNCDisplay:     1,
		},
		State: VmState{DiskPath: "/vms/vm-1/disk.qcow2"},
	}
	qemuArgs, err := buildQemuArgs(metadata, "whpx", "qemu64")
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	args := strings.Join(qemuArgs, " ")
	for _, expected := range []string{
		"-accel whpx,kernel-irqchip=off",
		"-cpu qemu64",
		"-smp 2",
		"-m 4096",
		"-vga none",
		"virtio-gpu-pci",
		"virtio-tablet-pci",
		"hostfwd=tcp:127.0.0.2:10023-:22",
		"hostfwd=tcp:127.0.0.2:17611-:7611",
		"hostfwd=tcp:127.0.0.2:17612-:7612",
		"-vnc 127.0.0.2:1",
		"-qmp tcp:127.0.0.2:14445,server,nowait",
		"seed.iso,if=virtio,media=cdrom,format=raw,readonly=on",
	} {
		if !strings.Contains(args, expected) {
			t.Fatalf("args missing %q: %s", expected, args)
		}
	}
}

func TestBuildQemuArgsAddsNoCloudNetProvisioningForLinux(t *testing.T) {
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID:              "vm-provision",
			BaseImagePath:   "/images/base.qcow2",
			ProvisioningURL: "http://10.0.2.2:6722/v1/vm-provision/token/",
			CPUCount:        2,
			MemoryMB:        4096,
			Desktop:         true,
			QMPPort:         14445,
			SSHHostPort:     10023,
			VNCDisplay:      1,
		},
		State: VmState{DiskPath: "/vms/vm-provision/disk.qcow2"},
	}
	qemuArgs, err := buildQemuArgs(metadata, "whpx", "qemu64")
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	args := strings.Join(qemuArgs, " ")
	if !strings.Contains(args, "-smbios type=1,serial=ds=nocloud-net;s=http://10.0.2.2:6722/v1/vm-provision/token/") {
		t.Fatalf("Linux provisioning args missing NoCloud-net SMBIOS: %s", args)
	}
	if !strings.Contains(args, "share=force-shared") {
		t.Fatalf("VNC args must allow a passive observer: %s", args)
	}

	metadata.Spec.OsFamily = OsWindows
	windowsArgs, err := buildQemuArgs(metadata, "whpx", "qemu64")
	if err != nil {
		t.Fatalf("build windows args: %v", err)
	}
	if strings.Contains(strings.Join(windowsArgs, " "), "nocloud-net") {
		t.Fatalf("Windows args must not contain Linux cloud-init provisioning")
	}
}

func TestBuildQemuArgsResolvesUnicodePaths(t *testing.T) {
	vmDir := filepath.Join("vms", "路径 测试", "vm-1")
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID:            "vm-1",
			BaseImagePath: filepath.Join("images", "base.qcow2"),
			SeedImagePath: filepath.Join(vmDir, "seed.iso"),
			CPUCount:      2,
			MemoryMB:      2048,
			QMPPort:       14445,
			SSHHostPort:   10023,
		},
		State: VmState{DiskPath: filepath.Join(vmDir, "disk.qcow2")},
	}
	resolver := func(path string) (string, error) {
		if isASCII(path) {
			return path, nil
		}
		return filepath.Join("C:", "runtime", filepath.Base(path)), nil
	}
	args, err := buildQemuArgsWithResolver(metadata, "whpx", "qemu64", resolver)
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "路径") {
		t.Fatalf("QEMU args still contain a non-ASCII path: %s", joined)
	}
	for _, expected := range []string{
		filepath.Join("C:", "runtime", "disk.qcow2"),
		filepath.Join("C:", "runtime", "seed.iso"),
		"file:" + filepath.Join("C:", "runtime", "console.log"),
		filepath.Join("C:", "runtime", "qemu.pid"),
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("args missing %q: %s", expected, joined)
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
	if err != nil || !strings.HasPrefix(console, "vnc://127.0.0.2:") {
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

func TestUsedVmResourcesSeparatesPortsAndLegacyVncSentinel(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "vm-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	metadata := vmMetadata{
		Spec: VmSpec{
			ID: "vm-1", Name: "Legacy", BaseImagePath: filepath.Join(root, "base.qcow2"),
			CPUCount: 2, MemoryMB: 2048, DiskSizeGB: 20,
			QMPPort: 41001, SSHHostPort: 41002, GuestHostPort: 41003, WorkerHostPort: 41004,
			VNCDisplay: 0,
		},
		State: VmState{ID: "vm-1", PowerState: PowerStopped},
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, metadataFilename), data, 0o600); err != nil {
		t.Fatal(err)
	}
	provider, err := NewQemuProvider(QemuConfig{StorageRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	used := provider.usedVmResources()
	if !used.qmpPorts[41001] || !used.sshPorts[41002] ||
		!used.guestPorts[41003] || !used.workerPorts[41004] {
		t.Fatalf("ports not reserved: %+v", used)
	}
	if used.vncDisplays[0] {
		t.Fatal("legacy display 0 must remain the unset sentinel")
	}
	display, err := freeVNCDisplay(used.vncDisplays)
	if err != nil {
		t.Fatal(err)
	}
	if display < 1 {
		t.Fatalf("new display must not reuse the sentinel, got %d", display)
	}
}
