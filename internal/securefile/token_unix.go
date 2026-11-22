//go:build !windows

package securefile

import (
	"fmt"
	"os"
	"syscall"
)

func openTokenFile(path string) (*os.File, error) {
	// O_NONBLOCK prevents a hostile FIFO from blocking before fstat can reject
	// it. O_NOFOLLOW makes the final-component symlink check race-free.
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("open token file %q without following links: %w", path, err)
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect opened token file %q: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		return nil, fmt.Errorf("token file %q is not a regular, non-symlink file", path)
	}
	if info.Mode().Perm() != 0o600 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		_ = file.Close()
		return nil, fmt.Errorf("token file %q must have mode exactly 0600", path)
	}
	if info.Size() < 1 || info.Size() > MaxTokenBytes {
		_ = file.Close()
		return nil, fmt.Errorf("token file %q must contain 1..%d bytes", path, MaxTokenBytes)
	}
	return file, nil
}

func replaceTokenFile(temporaryPath, path string) error {
	return os.Rename(temporaryPath, path)
}

func createTokenTemp(dir, pattern string) (*os.File, error) {
	// CreateTemp supplies the random name and O_EXCL. Re-open validation is not
	// needed: the returned descriptor is the object whose permissions we check.
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		_ = file.Close()
		_ = os.Remove(file.Name())
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("temporary token file is not a mode-0600 regular file")
	}
	return file, nil
}
