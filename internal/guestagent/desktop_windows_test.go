//go:build windows

package guestagent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsChordPlan(t *testing.T) {
	plan, err := windowsChordPlan([]string{"ctrl", "s"})
	if err != nil {
		t.Fatalf("chord plan: %v", err)
	}
	if len(plan) != 2 || plan[0].vk != 0x11 || plan[1].vk != 0x53 {
		t.Fatalf("unexpected ctrl+s plan: %+v", plan)
	}
	left, err := windowsChordPlan([]string{"left"})
	if err != nil {
		t.Fatalf("arrow plan: %v", err)
	}
	if len(left) != 1 || left[0].vk != 0x25 || left[0].flags&keyExtended == 0 {
		t.Fatalf("arrow key must be extended: %+v", left)
	}
	if _, err := windowsChordPlan([]string{"不存在的键"}); err == nil {
		t.Fatal("unknown multi-rune key was accepted")
	}
}

func TestWheelClicks(t *testing.T) {
	cases := map[float64]int{-240: 2, -1: 1, 0: 1, 119: 1, 2400: 20}
	for delta, expected := range cases {
		if actual := wheelClicks(delta); actual != expected {
			t.Fatalf("wheelClicks(%v) = %d, want %d", delta, actual, expected)
		}
	}
}

func TestWindowsSessionStateIsReported(t *testing.T) {
	state := sessionState()
	switch state {
	case "interactive", "locked", "secure_desktop":
	default:
		t.Fatalf("unexpected session state %q", state)
	}
}

func TestWindowsDesktopInfoDoesNotCapture(t *testing.T) {
	desktop := &windowsDesktop{}
	info, err := desktop.Info(context.Background())
	if err != nil {
		t.Skipf("no interactive desktop metrics in this environment: %v", err)
	}
	if info.DisplayServer != "windows" || info.Width <= 0 || info.Height <= 0 {
		t.Fatalf("unexpected desktop info: %+v", info)
	}
	if info.ScaleFactor <= 0 || info.DPI < 48 {
		t.Fatalf("invalid DPI metadata: %+v", info)
	}
}

func TestVerifyProcessFindsCurrentTestBinary(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Skipf("cannot resolve test executable: %v", err)
	}
	name := filepath.Base(executable)
	result := verifyProcess(VerifyCheck{Type: "process", Name: name})
	if !result.OK {
		t.Skipf("process snapshot unavailable or test binary not visible: %s", result.Error)
	}
	if len(result.PIDs) == 0 {
		t.Fatal("process check passed without PIDs")
	}
}

func TestVerifyProcessRejectsUnsafeNames(t *testing.T) {
	for _, name := range []string{"", "../evil.exe", "cmd/evil.exe", "evil:stream"} {
		result := verifyProcess(VerifyCheck{Type: "process", Name: name})
		if result.OK || result.ErrorCode != "invalid_process_name" {
			t.Fatalf("unsafe process name %q accepted: %+v", name, result)
		}
	}
}
