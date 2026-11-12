//go:build linux

package guestagent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyProcessFindsLiveProcess(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	name := filepath.Base(executable)

	result := verifyProcess(VerifyCheck{Type: "process", Name: name})
	if !result.OK {
		t.Fatalf("expected to find the live %q process, got %+v", name, result)
	}
	if len(result.PIDs) == 0 {
		t.Fatalf("expected at least one PID for %q, got %+v", name, result)
	}
}

func TestVerifyProcessReportsMissingProcess(t *testing.T) {
	result := verifyProcess(VerifyCheck{Type: "process", Name: "agent-in-box-missing-process"})
	if result.OK || result.ErrorCode != "process_not_found" {
		t.Fatalf("expected process_not_found, got %+v", result)
	}
}
