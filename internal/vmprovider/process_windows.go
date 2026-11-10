//go:build windows

package vmprovider

import (
	"os"
	"os/exec"
	"syscall"
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

func killProcess(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
