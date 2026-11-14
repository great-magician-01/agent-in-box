//go:build windows

package vmprovider

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const qemuNeedsASCIIPathsPlatform = true

var (
	kernel32GetShortPathNameW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetShortPathNameW")
	asciiDirectoryMutex       sync.Mutex
)

// getShortPathName calls GetShortPathNameW. The path must exist. The returned
// short name is not guaranteed to be ASCII: Windows generates 8.3 names in the
// OEM code page, so a Chinese directory may become e.g. "路径测~1".
func getShortPathName(path string) (string, error) {
	longPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", fmt.Errorf("encode path for GetShortPathNameW: %w", err)
	}
	need, _, callErr := kernel32GetShortPathNameW.Call(uintptr(unsafe.Pointer(longPtr)), 0, 0)
	if need == 0 {
		if callErr == syscall.Errno(0) {
			callErr = fmt.Errorf("returned 0")
		}
		return "", fmt.Errorf("GetShortPathNameW(%q): %w", path, callErr)
	}
	for attempt := 0; attempt < 2; attempt++ {
		buf := make([]uint16, need+1)
		got, _, callErr := kernel32GetShortPathNameW.Call(
			uintptr(unsafe.Pointer(longPtr)),
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(len(buf)),
		)
		if got == 0 {
			if callErr == syscall.Errno(0) {
				callErr = fmt.Errorf("returned 0")
			}
			return "", fmt.Errorf("GetShortPathNameW(%q): %w", path, callErr)
		}
		if got <= uintptr(len(buf)) {
			return syscall.UTF16ToString(buf[:int(got)]), nil
		}
		need = got
	}
	return "", fmt.Errorf("GetShortPathNameW(%q): short path buffer was too small", path)
}

// asciiDirectory returns an existing ASCII path for dir. It first tries an
// ASCII 8.3 short path. If that is unavailable (8.3 disabled) or the short
// name still contains non-ASCII code-page characters, it creates or reuses a
// directory junction under the user's local cache. Junctions are created with
// the built-in mklink /J, which does not require elevation. Source-directory
// junctions (for example a base image parent) are cached and shared; DeleteVm
// only removes the per-VM junction it created for the VM directory.
func asciiDirectory(dir string) (string, error) {
	if isASCII(dir) {
		return dir, nil
	}
	asciiDirectoryMutex.Lock()
	defer asciiDirectoryMutex.Unlock()

	if short, err := getShortPathName(dir); err == nil && isASCII(short) && short != dir {
		return short, nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("stat non-ASCII QEMU directory %q: %w", dir, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("non-ASCII QEMU path %q is not a directory", dir)
	}

	root, err := qemuRuntimeJunctionRoot()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create QEMU runtime junction root %q: %w", root, err)
	}
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	link := filepath.Join(root, hex.EncodeToString(sum[:])[:24])

	if _, lstatErr := os.Lstat(link); lstatErr == nil {
		if linkInfo, statErr := os.Stat(link); statErr == nil {
			if targetInfo, targetErr := os.Stat(dir); targetErr == nil && os.SameFile(linkInfo, targetInfo) {
				return link, nil
			}
		}
		if err := removeASCIIJunction(link); err != nil {
			return "", fmt.Errorf("remove stale QEMU runtime junction %q: %w", link, err)
		}
	}
	if err := createASCIIJunction(link, dir); err != nil {
		return "", err
	}
	linkInfo, err := os.Stat(link)
	if err != nil {
		return "", fmt.Errorf("verify QEMU runtime junction %q: %w", link, err)
	}
	targetInfo, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("stat QEMU directory %q: %w", dir, err)
	}
	if !os.SameFile(linkInfo, targetInfo) {
		return "", fmt.Errorf("QEMU runtime junction %q does not point to %q", link, dir)
	}
	return link, nil
}

func qemuRuntimeJunctionRoot() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("resolve user cache directory for QEMU runtime junctions: %w", err)
	}
	root := filepath.Join(cache, "AgentInBox", "vm-runtime", "dirs")
	if !isASCII(root) {
		return "", fmt.Errorf("QEMU runtime junction root %q contains non-ASCII characters; a non-ASCII user profile cannot be used with this QEMU build", root)
	}
	return root, nil
}

// cleanupQemuRuntimeJunction removes the cached junction for a VM directory
// after DeleteVm. It is best-effort; the caller only logs failures.
func cleanupQemuRuntimeJunction(dir string) error {
	if isASCII(dir) {
		return nil
	}
	asciiDirectoryMutex.Lock()
	defer asciiDirectoryMutex.Unlock()
	root, err := qemuRuntimeJunctionRoot()
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	link := filepath.Join(root, hex.EncodeToString(sum[:])[:24])
	if _, err := os.Lstat(link); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return removeASCIIJunction(link)
}

func assertSafeCmdPath(value string) error {
	if strings.ContainsAny(value, "&|<>^%\"\r\n") {
		return fmt.Errorf("path contains characters interpreted by cmd.exe: %q", value)
	}
	return nil
}

func createASCIIJunction(link, target string) error {
	if err := assertSafeCmdPath(link); err != nil {
		return err
	}
	if err := assertSafeCmdPath(target); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/c", "mklink", "/J", link, target)
	cmd.Dir = filepath.Dir(link)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// A concurrent process may have created the same hashed junction.
		if linkInfo, statErr := os.Stat(link); statErr == nil {
			if targetInfo, targetErr := os.Stat(target); targetErr == nil && os.SameFile(linkInfo, targetInfo) {
				return nil
			}
		}
		return fmt.Errorf("create ASCII junction %q -> %q: %w: %s", link, target, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func removeASCIIJunction(link string) error {
	if err := assertSafeCmdPath(link); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/c", "rmdir", link)
	cmd.Dir = filepath.Dir(link)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("remove ASCII junction %q: %w: %s", link, err, strings.TrimSpace(string(output)))
	}
	return nil
}
