// Package vmprovider contains the host-side VM provider prototype validated in
// phase 0. Providers own hypervisor processes; AI agents never receive arbitrary
// command execution on the host.
package vmprovider

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PowerState mirrors the protocol VM power states.
type PowerState string

const (
	PowerStopped   PowerState = "stopped"
	PowerStarting  PowerState = "starting"
	PowerRunning   PowerState = "running"
	PowerStopping  PowerState = "stopping"
	PowerSuspended PowerState = "suspended"
	PowerError     PowerState = "error"
)

var (
	ErrNotFound       = errors.New("vm not found")
	ErrAlreadyExists  = errors.New("vm already exists")
	ErrNotStopped     = errors.New("vm must be stopped for this operation")
	ErrNotRunning     = errors.New("vm is not running")
	ErrUnsupported    = errors.New("operation is not supported by this provider")
	ErrInvalidSpec    = errors.New("invalid vm specification")
	ErrQmpUnavailable = errors.New("qmp is unavailable")
)

const (
	// OsLinux is the default guest family for metadata written before phase 13.
	OsLinux = "linux"
	// OsWindows selects SATA/IDE storage, an e1000 NIC and standard VGA so a
	// stock Windows installation can boot without virtio guest drivers.
	OsWindows = "windows"
)

// VmSpec is the fixed, validated input for QEMU VM creation. The JSON tags are
// the HTTP boundary contract; encoding/json still accepts the historical
// upper-case field names from vm.json case-insensitively.
type VmSpec struct {
	ID string `json:"id"`
	// UUID is the QEMU machine UUID. It is generated once at creation and
	// persisted so query-uuid can prove that a loopback QMP endpoint belongs to
	// this VM even after a supervisor restart or PID reuse.
	UUID string `json:"uuid,omitempty"`
	// OsFamily is "linux" or "windows". An empty value means Linux so VM
	// metadata created before phase 13 remains readable.
	OsFamily      string `json:"osFamily,omitempty"`
	Name          string `json:"name"`
	BaseImagePath string `json:"baseImagePath"`
	SeedImagePath string `json:"seedImagePath"`
	// ProvisioningURL enables QEMU's NoCloud-net datasource through SMBIOS for
	// Linux cloud images that do not ship a prebuilt seed image.
	ProvisioningURL string `json:"provisioningUrl,omitempty"`
	CPUCount        int    `json:"cpuCount"`
	MemoryMB        int    `json:"memoryMb"`
	DiskSizeGB      int    `json:"diskSizeGb"`
	Desktop         bool   `json:"desktop"`
	QMPPort         int    `json:"qmpPort"`
	SSHHostPort     int    `json:"sshHostPort"`
	GuestHostPort   int    `json:"guestHostPort"`
	WorkerHostPort  int    `json:"workerHostPort"`
	VNCDisplay      int    `json:"vncDisplay"`
}

// EffectiveOsFamily normalizes the guest family and rejects unknown values.
func (s VmSpec) EffectiveOsFamily() (string, error) {
	switch strings.ToLower(strings.TrimSpace(s.OsFamily)) {
	case "", OsLinux:
		return OsLinux, nil
	case OsWindows:
		return OsWindows, nil
	default:
		return "", fmt.Errorf("%w: unsupported osFamily %q", ErrInvalidSpec, s.OsFamily)
	}
}

// VmState is persisted in the VM directory and reconciled with the real
// process. PowerState and GuestHealth are deliberately separate: suspend/resume
// only changes the power state and never fabricates guest health.
type VmState struct {
	ID         string     `json:"id"`
	PowerState PowerState `json:"powerState"`
	PID        int        `json:"pid"`
	// LaunchID identifies one QEMU launch of this VM. It changes on every start
	// and fences cleanup paths that raced a restart.
	LaunchID string `json:"launchId,omitempty"`
	// ProcessStartTicks is the OS process creation timestamp of the process that
	// owns LaunchID. A matching PID with a different start time is a reused PID,
	// not this VM's QEMU.
	ProcessStartTicks uint64 `json:"processStartTicks,omitempty"`
	// Transport records how QMP/VNC are exposed for this VM: "unix" (QMP on a
	// 0700-directory socket) or "tls" (mutually authenticated TLS). An empty
	// value is legacy metadata; it is only honoured while that process is still
	// running, and the next launch migrates to a secure transport.
	Transport      string    `json:"transport,omitempty"`
	QMPPort        int       `json:"qmpPort"`
	SSHHostPort    int       `json:"sshHostPort"`
	GuestHostPort  int       `json:"guestHostPort"`
	WorkerHostPort int       `json:"workerHostPort"`
	ConsoleURL     string    `json:"consoleUrl"`
	DiskPath       string    `json:"diskPath"`
	GuestHealth    string    `json:"guestHealth"`
	LastError      string    `json:"lastError"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// Provider is the Go counterpart of the shared protocol VmProvider contract.
type Provider interface {
	CreateVm(ctx context.Context, spec VmSpec) (VmState, error)
	StartVm(ctx context.Context, vmID string) (VmState, error)
	StopVm(ctx context.Context, vmID string, mode string) (VmState, error)
	SuspendVm(ctx context.Context, vmID string) (VmState, error)
	ResumeVm(ctx context.Context, vmID string) (VmState, error)
	GetVmState(ctx context.Context, vmID string) (VmState, error)
	CreateSnapshot(ctx context.Context, vmID string, tag string) (VmState, error)
	RestoreSnapshot(ctx context.Context, vmID string, tag string) (VmState, error)
	AttachConsole(ctx context.Context, vmID string) (string, error)
	DeleteVm(ctx context.Context, vmID string) error
}
