//go:build windows

package guestagent

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

const (
	th32csSnapProcess = 0x00000002
	invalidHandle     = ^uintptr(0)
)

type processEntry32 struct {
	size              uint32
	usage             uint32
	processID         uint32
	defaultHeapID     uintptr
	moduleID          uint32
	threads           uint32
	parentProcessID   uint32
	priorityClassBase int32
	flags             uint32
	exeFile           [260]uint16
}

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
)

// verifyProcess enumerates processes with Toolhelp32 and compares the executable
// name. It never opens the process, reads memory, signals it or runs a command.
func verifyProcess(check VerifyCheck) VerifyCheckResult {
	result := VerifyCheckResult{Type: "process"}
	name := strings.TrimSpace(check.Name)
	if name == "" || len(name) > 64 || strings.ContainsAny(name, "/\\:\x00") {
		return verifyFailure(result, "invalid_process_name", "process name must be 1..64 safe characters")
	}
	if !strings.Contains(name, ".") {
		name += ".exe"
	}

	snapshot, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if snapshot == invalidHandle || snapshot == 0 {
		return verifyFailure(result, "process_unavailable", "cannot create a process snapshot")
	}
	defer procCloseHandle.Call(snapshot)

	entry := processEntry32{size: uint32(unsafe.Sizeof(processEntry32{}))}
	ok, _, _ := procProcess32FirstW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		executable := syscall.UTF16ToString(entry.exeFile[:])
		if strings.EqualFold(executable, name) {
			result.PIDs = append(result.PIDs, int(entry.processID))
			if len(result.PIDs) >= maxVerifyProcessPIDs {
				break
			}
		}
		entry.size = uint32(unsafe.Sizeof(processEntry32{}))
		ok, _, _ = procProcess32NextW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	}
	if len(result.PIDs) == 0 {
		return verifyFailure(result, "process_not_found", fmt.Sprintf("no live process named %q", name))
	}
	result.OK = true
	return result
}
