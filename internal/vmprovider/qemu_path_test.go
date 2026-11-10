package vmprovider

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsASCII(t *testing.T) {
	if !isASCII(`C:\Users\admin\AppData\Local\AgentInBox`) {
		t.Fatal("ASCII path reported as non-ASCII")
	}
	if isASCII(`C:\Users\admin\AppData\Local\AgentInBox\路径 测试`) {
		t.Fatal("Unicode path reported as ASCII")
	}
}

func TestResolveQemuPathASCIIUnchanged(t *testing.T) {
	path := filepath.Join("vms", "vm-1", "disk.qcow2")
	called := false
	resolved, err := resolveQemuPath(path, true,
		func(string) (string, error) { called = true; return "", nil },
		func(string) (string, error) { called = true; return "", nil },
	)
	if err != nil {
		t.Fatalf("resolve ASCII path: %v", err)
	}
	if called {
		t.Fatal("resolver was called for an ASCII path")
	}
	if resolved != path {
		t.Fatalf("resolved = %q, want %q", resolved, path)
	}
}

func TestResolveQemuPathUsesASCIIShortPath(t *testing.T) {
	path := filepath.Join("vms", "路径 测试", "vm-1", "disk.qcow2")
	short := filepath.Join("short", "disk.qcow2")
	dirCalled := false
	resolved, err := resolveQemuPath(path, true,
		func(got string) (string, error) {
			if got != path {
				t.Fatalf("shortener got %q, want %q", got, path)
			}
			return short, nil
		},
		func(string) (string, error) { dirCalled = true; return "", nil },
	)
	if err != nil {
		t.Fatalf("resolve path: %v", err)
	}
	if dirCalled {
		t.Fatal("directory resolver was called when an ASCII short path existed")
	}
	if resolved != short {
		t.Fatalf("resolved = %q, want %q", resolved, short)
	}
}

func TestResolveQemuPathFallsBackToASCIIDirectory(t *testing.T) {
	parent := filepath.Join("vms", "路径 测试", "vm-1")
	path := filepath.Join(parent, "disk.qcow2")
	asciiParent := filepath.Join("runtime", "junction")
	resolved, err := resolveQemuPath(path, true,
		// Simulate GetShortPathNameW returning a short name that still contains
		// Chinese characters (or returning the long path unchanged).
		func(string) (string, error) { return filepath.Join("vms", "路径测~1", "DISK~1.QCOW"), nil },
		func(got string) (string, error) {
			if got != parent {
				t.Fatalf("directory resolver got %q, want %q", got, parent)
			}
			return asciiParent, nil
		},
	)
	if err != nil {
		t.Fatalf("resolve path: %v", err)
	}
	want := filepath.Join(asciiParent, "disk.qcow2")
	if resolved != want {
		t.Fatalf("resolved = %q, want %q", resolved, want)
	}
}

func TestResolveQemuPathRejectsNonASCIIBaseName(t *testing.T) {
	path := filepath.Join("vms", "路径 测试", "中文.qcow2")
	_, err := resolveQemuPath(path, true,
		func(string) (string, error) { return "", errors.New("no 8.3 name") },
		func(string) (string, error) { return filepath.Join("runtime", "junction"), nil },
	)
	if err == nil || !strings.Contains(err.Error(), "non-ASCII file name") {
		t.Fatalf("expected a clear non-ASCII base name error, got %v", err)
	}
}

func TestResolveQemuPathReportsUnavailableFallback(t *testing.T) {
	path := filepath.Join("vms", "路径 测试", "vm-1", "disk.qcow2")
	_, err := resolveQemuPath(path, true,
		func(string) (string, error) { return "", errors.New("8.3 disabled") },
		func(string) (string, error) { return "", errors.New("junction denied") },
	)
	if err == nil || !strings.Contains(err.Error(), "no ASCII short path or junction") {
		t.Fatalf("expected a clear unavailable-path error, got %v", err)
	}
	if !strings.Contains(err.Error(), "junction denied") {
		t.Fatalf("error lost the underlying cause: %v", err)
	}
}

func TestResolveQemuDirPathUsesDirectoryResolver(t *testing.T) {
	path := filepath.Join("vms", "路径 测试")
	resolved, err := resolveQemuDirPath(path, true,
		func(string) (string, error) { return path, nil },
		func(got string) (string, error) {
			if got != path {
				t.Fatalf("directory resolver got %q, want %q", got, path)
			}
			return filepath.Join("runtime", "dir-junction"), nil
		},
	)
	if err != nil {
		t.Fatalf("resolve directory: %v", err)
	}
	if want := filepath.Join("runtime", "dir-junction"); resolved != want {
		t.Fatalf("resolved = %q, want %q", resolved, want)
	}
}

func TestResolveQemuPathDisabledIsIdentity(t *testing.T) {
	path := filepath.Join("vms", "路径 测试", "vm-1", "disk.qcow2")
	called := false
	resolved, err := resolveQemuPath(path, false,
		func(string) (string, error) { called = true; return "", nil },
		func(string) (string, error) { called = true; return "", nil },
	)
	if err != nil {
		t.Fatalf("resolve path: %v", err)
	}
	if called {
		t.Fatal("resolver was called when conversion is disabled")
	}
	if resolved != path {
		t.Fatalf("resolved = %q, want %q", resolved, path)
	}
}
