package securefile

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallReadAndRotateToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := InstallTokenAtomically(path, "first-token"); err != nil {
		t.Fatal(err)
	}
	if value, err := ReadToken(path); err != nil || value != "first-token" {
		t.Fatalf("read installed token: %q, %v", value, err)
	}
	if err := InstallTokenAtomically(path, "second-token"); err != nil {
		t.Fatal(err)
	}
	if value, err := ReadToken(path); err != nil || value != "second-token" {
		t.Fatalf("read rotated token: %q, %v", value, err)
	}
}

func TestReadTokenRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks may require developer mode")
	}
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if err := InstallTokenAtomically(target, "secret"); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadToken(link); err == nil {
		t.Fatal("expected symlink token to be rejected")
	}
}

func TestReadTokenRejectsOpenUnixMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode assertion")
	}
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadToken(path); err == nil {
		t.Fatal("expected mode-0644 token to be rejected")
	}
}
