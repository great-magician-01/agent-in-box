package vmprovider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"agent-in-box/internal/securefile"
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
	if err != nil || !strings.HasPrefix(console, "vnc+tls://127.0.0.2:") ||
		!strings.Contains(console, "fingerprint=") || !strings.Contains(console, "cert=") {
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

func TestBuildQemuArgsUsesSecureTransports(t *testing.T) {
	root := t.TempDir()
	vmDir := filepath.Join(root, "vm-transport")
	if err := os.MkdirAll(vmDir, 0o700); err != nil {
		t.Fatal(err)
	}
	credentials, err := loadVMCredentials(vmDir)
	if err != nil {
		t.Fatalf("credentials: %v", err)
	}
	for _, name := range []string{tlsCACertFile, tlsServerCertFile, tlsServerKeyFile, tlsClientCertFile, tlsClientKeyFile} {
		path := filepath.Join(credentials.Dir, name)
		if _, err := securefile.ReadToken(path); err != nil {
			t.Fatalf("%s is not a protected credential file: %v", name, err)
		}
		if runtime.GOOS != "windows" {
			info, statErr := os.Stat(path)
			if statErr != nil {
				t.Fatalf("missing %s: %v", name, statErr)
			}
			if info.Mode().Perm()&0o077 != 0 {
				t.Fatalf("%s permissions are %o, want owner-only", name, info.Mode().Perm())
			}
		}
	}
	if len(credentials.Fingerprint) != 64 {
		t.Fatalf("fingerprint = %q", credentials.Fingerprint)
	}
	if _, err := pinnedClientConfig(credentials); err != nil {
		t.Fatalf("pinned client config: %v", err)
	}

	base := vmMetadata{
		Spec: VmSpec{
			ID: "vm-transport", UUID: testVMUUID, BaseImagePath: "/images/base.qcow2",
			CPUCount: 2, MemoryMB: 2048, QMPPort: 14445, VNCDisplay: 2,
		},
		State: VmState{DiskPath: filepath.Join(vmDir, "disk.qcow2")},
	}

	base.State.Transport = transportUnix
	unixArgs, err := buildQemuArgs(&base, "kvm", "max")
	if err != nil {
		t.Fatal(err)
	}
	unixJoined := strings.Join(unixArgs, " ")
	if !strings.Contains(unixJoined, "unix:") || !strings.Contains(unixJoined, "qmp.sock") {
		t.Fatalf("unix transport args missing qmp socket: %s", unixJoined)
	}
	if strings.Contains(unixJoined, "-qmp tcp:") {
		t.Fatalf("unix transport kept an unauthenticated qmp listener: %s", unixJoined)
	}
	if !strings.Contains(unixJoined, "tls-creds=vnc-tls0") || !strings.Contains(unixJoined, "verify-peer=on") {
		t.Fatalf("unix transport VNC is not TLS protected: %s", unixJoined)
	}

	base.State.Transport = transportTLS
	tlsArgs, err := buildQemuArgs(&base, "whpx", "qemu64")
	if err != nil {
		t.Fatal(err)
	}
	tlsJoined := strings.Join(tlsArgs, " ")
	for _, expected := range []string{
		"tls-creds-x509,id=vnc-tls0",
		"tls-creds-x509,id=qmp-tls0",
		"tls-creds=qmp-tls0",
		"tls-creds=vnc-tls0",
		"-qmp chardev=qmp0",
	} {
		if !strings.Contains(tlsJoined, expected) {
			t.Fatalf("tls transport args missing %q: %s", expected, tlsJoined)
		}
	}
	if strings.Contains(tlsJoined, "-qmp tcp:") {
		t.Fatalf("tls transport kept an unauthenticated qmp listener: %s", tlsJoined)
	}

	base.State.Transport = transportLegacy
	legacyArgs, err := buildQemuArgs(&base, "whpx", "qemu64")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(legacyArgs, " "), "tcp:127.0.0.2:14445") {
		t.Fatal("legacy transport no longer reproduces historical args")
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
	used, err := provider.usedVmResources()
	if err != nil {
		t.Fatal(err)
	}
	for port, role := range map[int]string{41001: "qmp", 41002: "ssh", 41003: "guest", 41004: "worker"} {
		if owner, ok := used.ports[port]; !ok || !strings.Contains(owner, role) {
			t.Fatalf("port %d (%s) not reserved as expected: %+v", port, role, used.ports)
		}
	}
	if used.vncDisplays[0] {
		t.Fatal("legacy display 0 must remain the unset sentinel")
	}
	display, err := freeVNCDisplay(used)
	if err != nil {
		t.Fatal(err)
	}
	if display < 1 {
		t.Fatalf("new display must not reuse the sentinel, got %d", display)
	}
}

func TestUsedVmResourcesRejectsCrossRoleAndCrossVmConflicts(t *testing.T) {
	root := t.TempDir()
	writeMetadata := func(id string, spec VmSpec) {
		t.Helper()
		dir := filepath.Join(root, id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(vmMetadata{Spec: spec, State: VmState{ID: id, PowerState: PowerStopped}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, metadataFilename), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeMetadata("vm-1", VmSpec{
		ID: "vm-1", BaseImagePath: "base", CPUCount: 1, MemoryMB: 512, DiskSizeGB: 1,
		QMPPort: 42001, SSHHostPort: 42002, VNCDisplay: 3,
	})
	provider, err := NewQemuProvider(QemuConfig{StorageRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	// Another VM's QMP port must not be reusable as this VM's guest port, and
	// VNC's implied 5903 must be in the same namespace.
	used, err := provider.usedVmResources()
	if err != nil {
		t.Fatal(err)
	}
	if err := used.reserve(42001, "guest"); err == nil {
		t.Fatal("cross-role port conflict was accepted")
	}
	if err := used.reserve(5903, "worker"); err == nil {
		t.Fatal("VNC port was not reserved in the TCP namespace")
	}
	if used.vncDisplays[3] != true {
		t.Fatal("VNC display was not reserved")
	}

	// Corrupt metadata must fail closed instead of silently freeing its ports.
	if err := os.WriteFile(filepath.Join(root, "vm-1", metadataFilename), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.usedVmResources(); err == nil {
		t.Fatal("corrupt metadata was skipped silently")
	}
}
