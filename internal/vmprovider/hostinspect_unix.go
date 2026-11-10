//go:build !windows

package vmprovider

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

var readFile = os.ReadFile

func totalPhysicalMemory() uint64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseUint(fields[1], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}

func freeDiskBytes(root string) uint64 {
	path := root
	for {
		if _, err := os.Stat(path); err == nil {
			break
		}
		parent := filepath.Dir(path)
		if parent == path {
			return 0
		}
		path = parent
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	return stat.Bavail * uint64(stat.Bsize)
}

func inspectAcceleration(_ QemuConfig) HostCheck {
	check := HostCheck{ID: "hardware_acceleration", Status: CheckError}
	handle, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		check.Message = fmt.Sprintf("/dev/kvm is not accessible: %v", err)
		return check
	}
	_ = handle.Close()
	check.Status = CheckOK
	check.Message = "KVM device is accessible"
	if version, err := os.ReadFile("/proc/version"); err == nil && strings.Contains(strings.ToLower(string(version)), "microsoft") {
		check.Status = CheckWarning
		check.Message = "KVM is accessible inside WSL2; this does not prove Windows-host WHPX support"
		check.Details = map[string]string{"wsl2": "true"}
	}
	return check
}
