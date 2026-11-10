//go:build windows

package vmprovider

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var readFile = os.ReadFile

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func totalPhysicalMemory() uint64 {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GlobalMemoryStatusEx")
	status := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	result, _, _ := proc.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		return 0
	}
	return status.TotalPhys
}

func freeDiskBytes(root string) uint64 {
	if root == "" {
		root = `C:\`
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GetDiskFreeSpaceExW")
	path, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0
	}
	var freeBytes uint64
	result, _, _ := proc.Call(
		uintptr(unsafe.Pointer(path)),
		uintptr(unsafe.Pointer(&freeBytes)),
		0,
		0,
	)
	if result == 0 {
		return 0
	}
	return freeBytes
}

func inspectAcceleration(_ QemuConfig) HostCheck {
	check := HostCheck{ID: "hardware_acceleration", Status: CheckError}
	dll, err := syscall.LoadDLL("WinHvPlatform.dll")
	if err != nil {
		check.Message = fmt.Sprintf("Windows Hypervisor Platform API is unavailable: %v", err)
		return check
	}
	defer dll.Release()
	proc, err := dll.FindProc("WHvGetCapability")
	if err != nil {
		check.Message = fmt.Sprintf("WHvGetCapability is unavailable: %v", err)
		return check
	}
	var present uint32
	var written uint32
	hr, _, _ := proc.Call(
		0, // WHvCapabilityCodeHypervisorPresent
		uintptr(unsafe.Pointer(&present)),
		4,
		uintptr(unsafe.Pointer(&written)),
	)
	if int32(hr) < 0 {
		check.Message = fmt.Sprintf("WHvGetCapability failed with HRESULT 0x%08x", hr)
		return check
	}
	if present == 0 {
		check.Message = "WHPX reports that no hypervisor is present"
		return check
	}
	check.Status = CheckOK
	check.Message = "WHPX hypervisor is present"
	check.Details = map[string]string{"whpx": "available"}
	return check
}
