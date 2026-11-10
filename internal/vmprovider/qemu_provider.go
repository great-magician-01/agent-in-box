package vmprovider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"agent-in-box/internal/qmp"
)

const metadataFilename = "vm.json"

type vmMetadata struct {
	Spec      VmSpec    `json:"spec"`
	State     VmState   `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
}

// QemuConfig points the provider at a fixed QEMU toolchain and storage root.
type QemuConfig struct {
	SystemBinary string
	ImageBinary  string
	StorageRoot  string
	Accelerator  string
	CPUModel     string
	Logger       *slog.Logger
}

// QemuProvider manages one qcow2 overlay and one QEMU process per VM.
type QemuProvider struct {
	config QemuConfig
	// locks serializes lifecycle operations per VM. A single supervisor process
	// is the only writer of vm.json, so this is sufficient to prevent concurrent
	// start/stop/suspend/resume races.
	locks keyedMutex
}

func NewQemuProvider(config QemuConfig) (*QemuProvider, error) {
	if config.StorageRoot == "" {
		return nil, fmt.Errorf("storage root is required")
	}
	if config.SystemBinary == "" {
		config.SystemBinary = "qemu-system-x86_64"
	}
	if config.ImageBinary == "" {
		config.ImageBinary = "qemu-img"
	}
	if runtime.GOOS == "windows" {
		if !strings.HasSuffix(config.SystemBinary, ".exe") {
			config.SystemBinary += ".exe"
		}
		if !strings.HasSuffix(config.ImageBinary, ".exe") {
			config.ImageBinary += ".exe"
		}
	}
	if config.Accelerator == "" {
		if runtime.GOOS == "windows" {
			config.Accelerator = "whpx"
		} else {
			config.Accelerator = "kvm"
		}
	}
	if config.CPUModel == "" {
		// Phase-0 WHPX validation on Intel Core Ultra 5 225H hung during SMP boot
		// with -cpu max; qemu64 is the verified conservative default until a
		// per-CPU capability probe is implemented.
		if runtime.GOOS == "windows" {
			config.CPUModel = "qemu64"
		} else {
			config.CPUModel = "max"
		}
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if err := os.MkdirAll(config.StorageRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create vm storage root: %w", err)
	}
	return &QemuProvider{config: config}, nil
}

var vmIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func validateSpec(spec VmSpec) error {
	if !vmIDPattern.MatchString(spec.ID) {
		return fmt.Errorf("%w: invalid vm id %q", ErrInvalidSpec, spec.ID)
	}
	if spec.BaseImagePath == "" {
		return fmt.Errorf("%w: base image is required", ErrInvalidSpec)
	}
	if _, err := os.Stat(spec.BaseImagePath); err != nil {
		return fmt.Errorf("%w: base image: %v", ErrInvalidSpec, err)
	}
	if spec.CPUCount < 1 || spec.CPUCount > 32 {
		return fmt.Errorf("%w: cpu count must be 1..32", ErrInvalidSpec)
	}
	if spec.MemoryMB < 512 || spec.MemoryMB > 65536 {
		return fmt.Errorf("%w: memory must be 512..65536 MB", ErrInvalidSpec)
	}
	if spec.DiskSizeGB < 1 || spec.DiskSizeGB > 2048 {
		return fmt.Errorf("%w: disk size must be 1..2048 GB", ErrInvalidSpec)
	}
	return nil
}

func (p *QemuProvider) vmDir(vmID string) (string, error) {
	if !vmIDPattern.MatchString(vmID) {
		return "", fmt.Errorf("%w: invalid vm id %q", ErrInvalidSpec, vmID)
	}
	return filepath.Join(p.config.StorageRoot, vmID), nil
}

func (p *QemuProvider) load(vmID string) (*vmMetadata, error) {
	dir, err := p.vmDir(vmID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, metadataFilename))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read vm metadata: %w", err)
	}
	var metadata vmMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, fmt.Errorf("decode vm metadata: %w", err)
	}
	return &metadata, nil
}

func (p *QemuProvider) save(metadata *vmMetadata) error {
	dir, err := p.vmDir(metadata.Spec.ID)
	if err != nil {
		return err
	}
	metadata.State.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(dir, metadataFilename+".tmp")
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(dir, metadataFilename))
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func freeVNCDisplay() (int, error) {
	for display := 0; display <= 20; display++ {
		address := net.JoinHostPort("127.0.0.1", strconv.Itoa(5900+display))
		listener, err := net.Listen("tcp", address)
		if err == nil {
			_ = listener.Close()
			return display, nil
		}
	}
	return 0, fmt.Errorf("no free loopback VNC display in 0..20")
}

func (p *QemuProvider) CreateVm(ctx context.Context, spec VmSpec) (VmState, error) {
	if err := validateSpec(spec); err != nil {
		return VmState{}, err
	}
	unlock := p.locks.Lock(spec.ID)
	defer unlock()
	dir, err := p.vmDir(spec.ID)
	if err != nil {
		return VmState{}, err
	}
	if _, err := os.Stat(filepath.Join(dir, metadataFilename)); err == nil {
		return VmState{}, ErrAlreadyExists
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return VmState{}, fmt.Errorf("create vm directory: %w", err)
	}

	if spec.QMPPort == 0 {
		spec.QMPPort, err = freePort()
		if err != nil {
			return VmState{}, fmt.Errorf("allocate qmp port: %w", err)
		}
	}
	if spec.SSHHostPort == 0 {
		spec.SSHHostPort, err = freePort()
		if err != nil {
			return VmState{}, fmt.Errorf("allocate ssh port: %w", err)
		}
	}
	if spec.GuestHostPort == 0 {
		spec.GuestHostPort, err = freePort()
		if err != nil {
			return VmState{}, fmt.Errorf("allocate guest agent port: %w", err)
		}
	}
	if spec.VNCDisplay == 0 {
		spec.VNCDisplay, err = freeVNCDisplay()
		if err != nil {
			return VmState{}, err
		}
	}

	diskPath := filepath.Join(dir, "disk.qcow2")
	// On Windows, QEMU cannot open non-ASCII paths. qemu-img itself handles
	// them, but the backing file name written into the qcow2 is later opened by
	// QEMU, so both the backing image and the overlay path must be converted to
	// an ASCII short path or junction before qemu-img creates the overlay.
	baseImagePath, err := resolveQemuPathDefault(spec.BaseImagePath)
	if err != nil {
		return VmState{}, fmt.Errorf("prepare QEMU base image path: %w", err)
	}
	overlayPath, err := resolveQemuPathDefault(diskPath)
	if err != nil {
		return VmState{}, fmt.Errorf("prepare QEMU overlay path: %w", err)
	}
	command := exec.CommandContext(ctx, p.config.ImageBinary,
		"create", "-f", "qcow2", "-F", "qcow2", "-b", baseImagePath, overlayPath,
		strconv.Itoa(spec.DiskSizeGB)+"G")
	if output, err := command.CombinedOutput(); err != nil {
		return VmState{}, fmt.Errorf("create qcow2 overlay: %w: %s", err, strings.TrimSpace(string(output)))
	}

	metadata := &vmMetadata{
		Spec:      spec,
		CreatedAt: time.Now().UTC(),
		State: VmState{
			ID:            spec.ID,
			PowerState:    PowerStopped,
			QMPPort:       spec.QMPPort,
			SSHHostPort:   spec.SSHHostPort,
			GuestHostPort: spec.GuestHostPort,
			ConsoleURL:    fmt.Sprintf("vnc://127.0.0.1:%d", 5900+spec.VNCDisplay),
			DiskPath:      diskPath,
			GuestHealth:   "unknown",
		},
	}
	if err := p.save(metadata); err != nil {
		return VmState{}, fmt.Errorf("save vm metadata: %w", err)
	}
	return metadata.State, nil
}

func buildQemuArgs(metadata *vmMetadata, accelerator string, cpuModel string) ([]string, error) {
	return buildQemuArgsWithResolver(metadata, accelerator, cpuModel, resolveQemuPathDefault)
}

func buildQemuArgsWithResolver(metadata *vmMetadata, accelerator string, cpuModel string, resolve func(string) (string, error)) ([]string, error) {
	spec := metadata.Spec
	state := metadata.State
	vmDir := filepath.Dir(state.DiskPath)
	diskPath, err := resolve(state.DiskPath)
	if err != nil {
		return nil, fmt.Errorf("overlay disk: %w", err)
	}
	consolePath, err := resolve(filepath.Join(vmDir, "console.log"))
	if err != nil {
		return nil, fmt.Errorf("serial console: %w", err)
	}
	pidPath, err := resolve(filepath.Join(vmDir, "qemu.pid"))
	if err != nil {
		return nil, fmt.Errorf("pid file: %w", err)
	}
	args := []string{
		"-name", "agent-in-box-" + spec.ID,
		"-machine", "q35",
		"-accel", accelerator + ",kernel-irqchip=off",
		"-cpu", cpuModel,
		"-smp", strconv.Itoa(spec.CPUCount),
		"-m", strconv.Itoa(spec.MemoryMB),
		"-drive", "file=" + diskPath + ",if=virtio,format=qcow2",
	}
	if spec.SeedImagePath != "" {
		seedPath, err := resolve(spec.SeedImagePath)
		if err != nil {
			return nil, fmt.Errorf("seed image: %w", err)
		}
		args = append(args, "-drive", "file="+seedPath+",if=virtio,media=cdrom,format=raw,readonly=on")
	}
	if spec.Desktop {
		// Remove the default std VGA: leaving it beside virtio-gpu made Xorg
		// abort with "Cannot run in framebuffer mode". virtio-tablet provides
		// absolute pointer input without requiring a q35 USB controller.
		args = append(args, "-vga", "none", "-device", "virtio-gpu-pci", "-device", "virtio-tablet-pci")
	}
	network := fmt.Sprintf("user,id=n0,hostfwd=tcp:127.0.0.1:%d-:22", spec.SSHHostPort)
	if spec.GuestHostPort > 0 {
		network += fmt.Sprintf(",hostfwd=tcp:127.0.0.1:%d-:7611", spec.GuestHostPort)
	}
	args = append(args,
		"-netdev", network,
		"-device", "virtio-net-pci,netdev=n0",
		"-display", "none",
		"-vnc", fmt.Sprintf("127.0.0.1:%d", spec.VNCDisplay),
		"-serial", "file:"+consolePath,
		"-qmp", fmt.Sprintf("tcp:127.0.0.1:%d,server,nowait", spec.QMPPort),
		"-pidfile", pidPath,
	)
	return args, nil
}

func (p *QemuProvider) qmpAddress(metadata *vmMetadata) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(metadata.Spec.QMPPort))
}

func (p *QemuProvider) failStart(metadata *vmMetadata, err error) (VmState, error) {
	metadata.State.PowerState = PowerError
	metadata.State.LastError = err.Error()
	_ = p.save(metadata)
	return metadata.State, err
}

func (p *QemuProvider) StartVm(ctx context.Context, vmID string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if metadata.State.PID > 0 && processAlive(metadata.State.PID) {
		qmpCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if client, err := qmp.Dial(qmpCtx, p.qmpAddress(metadata), nil); err == nil {
			status, queryErr := client.QueryStatus(qmpCtx)
			_ = client.Close()
			if queryErr == nil {
				switch status.Status {
				case "running":
					metadata.State.PowerState = PowerRunning
				case "suspended", "paused":
					metadata.State.PowerState = PowerSuspended
				default:
					return VmState{}, fmt.Errorf("%w: existing qemu process is %s", ErrNotRunning, status.Status)
				}
				metadata.State.LastError = ""
				return metadata.State, p.save(metadata)
			}
		}
		return VmState{}, fmt.Errorf("%w: existing qemu process %d did not answer", ErrQmpUnavailable, metadata.State.PID)
	}

	arguments, err := buildQemuArgs(metadata, p.config.Accelerator, p.config.CPUModel)
	if err != nil {
		return p.failStart(metadata, fmt.Errorf("prepare QEMU paths: %w", err))
	}
	// MSYS2 QEMU resolves VNC keymaps such as 'en-us' through its data
	// directory. Pin it explicitly so startup does not depend on the caller's
	// working directory (which may even be a UNC path under WSL).
	dataDir := filepath.Clean(filepath.Join(filepath.Dir(p.config.SystemBinary), "..", "share", "qemu"))
	if info, err := os.Stat(dataDir); err == nil && info.IsDir() {
		asciiDataDir, err := resolveQemuDirPathDefault(dataDir)
		if err != nil {
			return p.failStart(metadata, fmt.Errorf("prepare QEMU data directory: %w", err))
		}
		arguments = append(arguments, "-L", asciiDataDir)
	}
	qemuDir, err := resolveQemuDirPathDefault(filepath.Dir(metadata.State.DiskPath))
	if err != nil {
		return p.failStart(metadata, fmt.Errorf("prepare QEMU working directory: %w", err))
	}
	command := exec.Command(p.config.SystemBinary, arguments...)
	command.Dir = qemuDir
	configureDetachedProcess(command)
	stderr, err := os.Create(filepath.Join(filepath.Dir(metadata.State.DiskPath), "qemu-stderr.log"))
	if err != nil {
		return VmState{}, fmt.Errorf("create qemu stderr log: %w", err)
	}
	defer stderr.Close()
	command.Stdout = stderr
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		metadata.State.PowerState = PowerError
		metadata.State.LastError = err.Error()
		_ = p.save(metadata)
		return VmState{}, fmt.Errorf("start qemu: %w", err)
	}
	metadata.State.PID = command.Process.Pid
	metadata.State.PowerState = PowerStarting
	metadata.State.LastError = ""
	if err := p.save(metadata); err != nil {
		return VmState{}, err
	}
	if err := command.Process.Release(); err != nil {
		p.config.Logger.Warn("release qemu process handle", "error", err)
	}

	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(metadata.State.PID) {
			metadata.State.PowerState = PowerError
			metadata.State.LastError = "qemu exited before QMP became available"
			_ = p.save(metadata)
			return metadata.State, fmt.Errorf("qemu exited during startup")
		}
		dialCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		client, err := qmp.Dial(dialCtx, p.qmpAddress(metadata), nil)
		if err == nil {
			_, queryErr := client.QueryStatus(dialCtx)
			_ = client.Close()
			if queryErr == nil {
				cancel()
				metadata.State.PowerState = PowerRunning
				return metadata.State, p.save(metadata)
			}
		}
		cancel()
		time.Sleep(500 * time.Millisecond)
	}
	metadata.State.PowerState = PowerError
	metadata.State.LastError = ErrQmpUnavailable.Error()
	_ = p.save(metadata)
	return metadata.State, ErrQmpUnavailable
}

func (p *QemuProvider) StopVm(ctx context.Context, vmID string, mode string) (VmState, error) {
	if mode != "graceful" && mode != "force" {
		return VmState{}, fmt.Errorf("%w: stop mode must be graceful or force", ErrInvalidSpec)
	}
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if metadata.State.PID == 0 || !processAlive(metadata.State.PID) {
		metadata.State.PID = 0
		metadata.State.PowerState = PowerStopped
		metadata.State.GuestHealth = "unknown"
		return metadata.State, p.save(metadata)
	}

	pid := metadata.State.PID
	metadata.State.PowerState = PowerStopping
	if err := p.save(metadata); err != nil {
		return VmState{}, err
	}

	qmpCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	client, qmpErr := qmp.Dial(qmpCtx, p.qmpAddress(metadata), nil)
	if qmpErr == nil {
		if mode == "graceful" {
			qmpErr = client.SystemPowerdown(qmpCtx)
		} else {
			qmpErr = client.Quit(qmpCtx)
		}
		_ = client.Close()
	}
	cancel()
	if qmpErr != nil && mode == "graceful" {
		p.config.Logger.Warn("graceful qmp shutdown failed; forcing process stop", "vm", vmID, "error", qmpErr)
	}

	deadline := time.Now().Add(75 * time.Second)
	if mode == "force" {
		deadline = time.Now().Add(10 * time.Second)
	}
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
	}
	if processAlive(pid) {
		if err := killProcess(pid); err != nil {
			return VmState{}, fmt.Errorf("kill qemu process %d: %w", pid, err)
		}
	}
	metadata.State.PID = 0
	metadata.State.PowerState = PowerStopped
	metadata.State.GuestHealth = "unknown"
	metadata.State.LastError = ""
	return metadata.State, p.save(metadata)
}

func (p *QemuProvider) GetVmState(ctx context.Context, vmID string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if metadata.State.PID == 0 || !processAlive(metadata.State.PID) {
		metadata.State.PID = 0
		metadata.State.PowerState = PowerStopped
		metadata.State.GuestHealth = "unknown"
		return metadata.State, p.save(metadata)
	}

	qmpCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	client, err := qmp.Dial(qmpCtx, p.qmpAddress(metadata), nil)
	if err != nil {
		metadata.State.PowerState = PowerError
		metadata.State.LastError = err.Error()
		return metadata.State, p.save(metadata)
	}
	defer client.Close()
	status, err := client.QueryStatus(qmpCtx)
	if err != nil {
		metadata.State.PowerState = PowerError
		metadata.State.LastError = err.Error()
		return metadata.State, p.save(metadata)
	}
	metadata.State.PowerState = powerStateFromQMP(status.Status)
	metadata.State.LastError = ""
	return metadata.State, p.save(metadata)
}

func powerStateFromQMP(status string) PowerState {
	switch status {
	case "running":
		return PowerRunning
	case "suspended", "paused":
		return PowerSuspended
	case "shutdown":
		return PowerStopped
	default:
		return PowerError
	}
}

// suspendClient opens one short-lived QMP connection for a state transition.
// It never forwards arbitrary commands: only query-status, stop and cont are
// reachable through this path.
func (p *QemuProvider) suspendClient(ctx context.Context, metadata *vmMetadata) (*qmp.Client, context.Context, context.CancelFunc, error) {
	qmpCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	client, err := qmp.Dial(qmpCtx, p.qmpAddress(metadata), nil)
	if err != nil {
		cancel()
		return nil, nil, nil, fmt.Errorf("%w: %v", ErrQmpUnavailable, err)
	}
	return client, qmpCtx, cancel, nil
}

// SuspendVm pauses vCPUs through the fixed QMP stop command. A VM that is
// already suspended is returned unchanged (idempotent); the command is only
// sent when query-status reports a running VM.
func (p *QemuProvider) SuspendVm(ctx context.Context, vmID string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if metadata.State.PID == 0 || !processAlive(metadata.State.PID) {
		metadata.State.PID = 0
		metadata.State.PowerState = PowerStopped
		metadata.State.GuestHealth = "unknown"
		if err := p.save(metadata); err != nil {
			return VmState{}, err
		}
		return VmState{}, fmt.Errorf("%w: cannot suspend a stopped vm", ErrNotRunning)
	}

	client, qmpCtx, cancel, err := p.suspendClient(ctx, metadata)
	if err != nil {
		return p.failSuspendResume(metadata, err)
	}
	defer cancel()
	defer client.Close()

	status, err := client.QueryStatus(qmpCtx)
	if err != nil {
		return p.failSuspendResume(metadata, fmt.Errorf("%w: %v", ErrQmpUnavailable, err))
	}
	switch status.Status {
	case "suspended", "paused":
		metadata.State.PowerState = PowerSuspended
		metadata.State.LastError = ""
		return metadata.State, p.save(metadata)
	case "running":
		if err := client.Stop(qmpCtx); err != nil {
			return p.failSuspendResume(metadata, fmt.Errorf("pause qemu: %w", err))
		}
		metadata.State.PowerState = PowerSuspended
		metadata.State.LastError = ""
		return metadata.State, p.save(metadata)
	default:
		metadata.State.PowerState = powerStateFromQMP(status.Status)
		metadata.State.LastError = fmt.Sprintf("cannot suspend while qemu status is %q", status.Status)
		_ = p.save(metadata)
		return VmState{}, fmt.Errorf("%w: qemu status %s", ErrNotRunning, status.Status)
	}
}

// ResumeVm resumes vCPUs through the fixed QMP cont command. A VM that is
// already running is returned unchanged (idempotent); cont is only sent when
// query-status reports a suspended/paused VM.
func (p *QemuProvider) ResumeVm(ctx context.Context, vmID string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if metadata.State.PID == 0 || !processAlive(metadata.State.PID) {
		metadata.State.PID = 0
		metadata.State.PowerState = PowerStopped
		metadata.State.GuestHealth = "unknown"
		if err := p.save(metadata); err != nil {
			return VmState{}, err
		}
		return VmState{}, fmt.Errorf("%w: cannot resume a stopped vm", ErrNotRunning)
	}

	client, qmpCtx, cancel, err := p.suspendClient(ctx, metadata)
	if err != nil {
		return p.failSuspendResume(metadata, err)
	}
	defer cancel()
	defer client.Close()

	status, err := client.QueryStatus(qmpCtx)
	if err != nil {
		return p.failSuspendResume(metadata, fmt.Errorf("%w: %v", ErrQmpUnavailable, err))
	}
	switch status.Status {
	case "running":
		metadata.State.PowerState = PowerRunning
		metadata.State.LastError = ""
		return metadata.State, p.save(metadata)
	case "suspended", "paused":
		if err := client.Cont(qmpCtx); err != nil {
			return p.failSuspendResume(metadata, fmt.Errorf("resume qemu: %w", err))
		}
		metadata.State.PowerState = PowerRunning
		metadata.State.LastError = ""
		return metadata.State, p.save(metadata)
	default:
		metadata.State.PowerState = powerStateFromQMP(status.Status)
		metadata.State.LastError = fmt.Sprintf("cannot resume while qemu status is %q", status.Status)
		_ = p.save(metadata)
		return VmState{}, fmt.Errorf("%w: qemu status %s", ErrNotRunning, status.Status)
	}
}

func (p *QemuProvider) failSuspendResume(metadata *vmMetadata, err error) (VmState, error) {
	metadata.State.PowerState = PowerError
	metadata.State.LastError = err.Error()
	_ = p.save(metadata)
	return VmState{}, err
}

func (p *QemuProvider) requireStopped(metadata *vmMetadata) error {
	if metadata.State.PID > 0 && processAlive(metadata.State.PID) {
		return ErrNotStopped
	}
	return nil
}

func (p *QemuProvider) CreateSnapshot(ctx context.Context, vmID string, tag string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if err := p.requireStopped(metadata); err != nil {
		return VmState{}, err
	}
	if tag == "" || strings.ContainsAny(tag, " \t\r\n") {
		return VmState{}, fmt.Errorf("%w: invalid snapshot tag", ErrInvalidSpec)
	}
	command := exec.CommandContext(ctx, p.config.ImageBinary, "snapshot", "-c", tag, metadata.State.DiskPath)
	if output, err := command.CombinedOutput(); err != nil {
		return VmState{}, fmt.Errorf("create snapshot: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return metadata.State, nil
}

func (p *QemuProvider) RestoreSnapshot(ctx context.Context, vmID string, tag string) (VmState, error) {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return VmState{}, err
	}
	if err := p.requireStopped(metadata); err != nil {
		return VmState{}, err
	}
	command := exec.CommandContext(ctx, p.config.ImageBinary, "snapshot", "-a", tag, metadata.State.DiskPath)
	if output, err := command.CombinedOutput(); err != nil {
		return VmState{}, fmt.Errorf("restore snapshot: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return metadata.State, nil
}

func (p *QemuProvider) AttachConsole(ctx context.Context, vmID string) (string, error) {
	metadata, err := p.load(vmID)
	if err != nil {
		return "", err
	}
	return metadata.State.ConsoleURL, nil
}

func (p *QemuProvider) DeleteVm(ctx context.Context, vmID string) error {
	unlock := p.locks.Lock(vmID)
	defer unlock()

	metadata, err := p.load(vmID)
	if err != nil {
		return err
	}
	if err := p.requireStopped(metadata); err != nil {
		return err
	}
	dir, err := p.vmDir(vmID)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := cleanupQemuRuntimeJunction(dir); err != nil {
		p.config.Logger.Warn("clean up QEMU runtime junction", "vm", vmID, "error", err)
	}
	return nil
}
