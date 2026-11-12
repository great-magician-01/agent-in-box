//go:build linux

package guestagent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// verifyProcess checks that at least one live process has the exact requested
// executable name. It reads /proc only; no process signal or command is sent.
func verifyProcess(check VerifyCheck) VerifyCheckResult {
	result := VerifyCheckResult{Type: "process"}
	name := strings.TrimSpace(check.Name)
	if name == "" || len(name) > 64 || strings.ContainsAny(name, "/\\\x00") {
		return verifyFailure(result, "invalid_process_name", "process name must be 1..64 safe characters")
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return verifyFailure(result, "process_unavailable", "cannot read /proc")
	}
	seen := make(map[int]struct{})
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil || pid <= 0 {
			continue
		}
		if _, exists := seen[pid]; exists {
			continue
		}
		if processMatches(pid, name) {
			seen[pid] = struct{}{}
			result.PIDs = append(result.PIDs, pid)
			if len(result.PIDs) >= maxVerifyProcessPIDs {
				break
			}
		}
	}
	if len(result.PIDs) == 0 {
		return verifyFailure(result, "process_not_found", fmt.Sprintf("no live process named %q", name))
	}
	result.OK = true
	return result
}

func processMatches(pid int, name string) bool {
	directory := filepath.Join("/proc", strconv.Itoa(pid))
	if comm, err := os.ReadFile(filepath.Join(directory, "comm")); err == nil {
		if strings.TrimSpace(string(comm)) == name {
			return true
		}
	}
	cmdline, err := os.ReadFile(filepath.Join(directory, "cmdline"))
	if err != nil {
		return false
	}
	first := strings.SplitN(string(cmdline), "\x00", 2)[0]
	return first != "" && filepath.Base(first) == name
}
