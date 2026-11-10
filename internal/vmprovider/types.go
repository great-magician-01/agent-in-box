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
	ErrUnsupported    = errors.New("operation is not supported by this provider")
	ErrInvalidSpec    = errors.New("invalid vm specification")
	ErrQmpUnavailable = errors.New("qmp is unavailable")
)

// VmSpec is the fixed, validated input for QEMU VM creation.
type VmSpec struct {
	ID            string
	Name          string
	BaseImagePath string
	SeedImagePath string
	CPUCount      int
	MemoryMB      int
	DiskSizeGB    int
	Desktop       bool
	QMPPort       int
	SSHHostPort   int
	VNCDisplay    int
}

// VmState is persisted in the VM directory and reconciled with the real process.
type VmState struct {
	ID          string
	PowerState  PowerState
	PID         int
	QMPPort     int
	SSHHostPort int
	ConsoleURL  string
	DiskPath    string
	GuestHealth string
	LastError   string
	UpdatedAt   time.Time
}

// Provider is the Go counterpart of the shared protocol VmProvider contract.
type Provider interface {
	CreateVm(ctx context.Context, spec VmSpec) (VmState, error)
	StartVm(ctx context.Context, vmID string) (VmState, error)
	StopVm(ctx context.Context, vmID string, mode string) (VmState, error)
	GetVmState(ctx context.Context, vmID string) (VmState, error)
	CreateSnapshot(ctx context.Context, vmID string, tag string) (VmState, error)
	RestoreSnapshot(ctx context.Context, vmID string, tag string) (VmState, error)
	AttachConsole(ctx context.Context, vmID string) (string, error)
	DeleteVm(ctx context.Context, vmID string) error
}
