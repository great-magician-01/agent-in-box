//go:build !windows

package vmprovider

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func configureDetachedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// A zombie still answers signal 0. On Linux, read the process state and
	// treat it as exited; the Wait goroutine will reap it.
	if stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		if closeParen := strings.LastIndexByte(string(stat), ')'); closeParen >= 0 {
			fields := strings.Fields(string(stat)[closeParen+1:])
			if len(fields) > 0 && fields[0] == "Z" {
				return false
			}
		}
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processImage(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
}

// processStartTicks reads the process creation timestamp (field 22 of
// /proc/<pid>/stat, in clock ticks since boot). It lets a later operation tell
// a surviving QEMU apart from an unrelated process that reused its PID.
func processStartTicks(pid int) (uint64, error) {
	if pid <= 0 {
		return 0, errors.New("invalid pid")
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, err
	}
	closeParen := strings.LastIndexByte(string(stat), ')')
	if closeParen < 0 {
		return 0, errors.New("malformed /proc stat")
	}
	fields := strings.Fields(string(stat)[closeParen+1:])
	// fields[0] is field 3 (state); starttime is field 22.
	const startTimeIndex = 22 - 3
	if len(fields) <= startTimeIndex {
		return 0, errors.New("truncated /proc stat")
	}
	return strconv.ParseUint(fields[startTimeIndex], 10, 64)
}

// processIdentityAlive reports whether pid is still the same process that was
// launched at startTicks. A zero startTicks means legacy metadata that never
// recorded the identity; the result is then conservative (PID liveness only).
func processIdentityAlive(pid int, startTicks uint64) bool {
	if !processAlive(pid) {
		return false
	}
	if startTicks == 0 {
		return true
	}
	current, err := processStartTicks(pid)
	if err != nil {
		// Cannot prove the identity changed, so treat the process as alive. A
		// stop then fails closed rather than falsely reporting "stopped".
		return true
	}
	return current == startTicks
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
