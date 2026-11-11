// Package vmprovider contains the host-side VM provider prototype validated in
// phase 0. Providers own hypervisor processes; AI agents never receive arbitrary
// command execution on the host.
package vmprovider

import (
	"context"
	"errors"
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

// VmSpec is the fixed, validated input for QEMU VM creation. The JSON tags are
// the HTTP boundary contract; encoding/json still accepts the historical
// upper-case field names from vm.json case-insensitively.
type VmSpec struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	BaseImagePath  string `json:"baseImagePath"`
	SeedImagePath  string `json:"seedImagePath"`
	CPUCount       int    `json:"cpuCount"`
	MemoryMB       int    `json:"memoryMb"`
	DiskSizeGB     int    `json:"diskSizeGb"`
	Desktop        bool   `json:"desktop"`
	QMPPort        int    `json:"qmpPort"`
	SSHHostPort    int    `json:"sshHostPort"`
	GuestHostPort  int    `json:"guestHostPort"`
	WorkerHostPort int    `json:"workerHostPort"`
	VNCDisplay     int    `json:"vncDisplay"`
}

// VmState is persisted in the VM directory and reconciled with the real
// process. PowerState and GuestHealth are deliberately separate: suspend/resume
// only changes the power state and never fabricates guest health.
type VmState struct {
	ID             string     `json:"id"`
	PowerState     PowerState `json:"powerState"`
	PID            int        `json:"pid"`
	QMPPort        int        `json:"qmpPort"`
	SSHHostPort    int        `json:"sshHostPort"`
	GuestHostPort  int        `json:"guestHostPort"`
	WorkerHostPort int        `json:"workerHostPort"`
	ConsoleURL     string     `json:"consoleUrl"`
	DiskPath       string     `json:"diskPath"`
	GuestHealth    string     `json:"guestHealth"`
	LastError      string     `json:"lastError"`
	UpdatedAt      time.Time  `json:"updatedAt"`
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
