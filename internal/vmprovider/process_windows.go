//go:build windows

package vmprovider

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	processQueryLimitedInformation = 0x1000
	createNewProcessGroup          = 0x00000200
)

func configureDetachedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	openProcess := kernel32.NewProc("OpenProcess")
	handle, _, err := openProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if handle == 0 {
		return false
	}
	closeHandle := kernel32.NewProc("CloseHandle")
	_, _, _ = closeHandle.Call(handle)
	_ = err
	return true
}

func processImage(pid int) (string, error) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	openProcess := kernel32.NewProc("OpenProcess")
	handle, _, openErr := openProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if handle == 0 {
		return "", openErr
	}
	defer func() {
		closeHandle := kernel32.NewProc("CloseHandle")
		_, _, _ = closeHandle.Call(handle)
	}()
	query := kernel32.NewProc("QueryFullProcessImageNameW")
	buffer := make([]uint16, 1024)
	size := uint32(len(buffer))
	ok, _, queryErr := query.Call(
		handle,
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ok == 0 {
		return "", queryErr
	}
	return syscall.UTF16ToString(buffer[:size]), nil
}

func killProcess(pid int) error {
	if err := assertQemuProcess(pid); err != nil {
		return err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
