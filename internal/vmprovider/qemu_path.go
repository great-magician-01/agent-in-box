package vmprovider

import (
	"fmt"
	"path/filepath"
)

// shortPathFunc resolves an existing Windows path to an ASCII 8.3 short path.
type shortPathFunc func(string) (string, error)

// asciiDirFunc returns an ASCII path that refers to the given existing
// directory. On Windows this may create a directory junction.
type asciiDirFunc func(string) (string, error)

// qemuNeedsASCIIPaths is true on Windows, where the MSYS2 QEMU build uses
// ANSI file APIs and cannot open paths containing non-ASCII characters.
const qemuNeedsASCIIPaths = qemuNeedsASCIIPathsPlatform

func isASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] >= 0x80 {
			return false
		}
	}
	return true
}

func resolveQemuPathDefault(path string) (string, error) {
	return resolveQemuPath(path, qemuNeedsASCIIPaths, getShortPathName, asciiDirectory)
}

func resolveQemuDirPathDefault(path string) (string, error) {
	return resolveQemuDirPath(path, qemuNeedsASCIIPaths, getShortPathName, asciiDirectory)
}

// resolveQemuPath returns a path that QEMU can open. On Windows, non-ASCII
// paths are first tried through GetShortPathNameW. 8.3 short names are
// generated in the OEM code page, so Chinese directories can still yield a
// short name containing Chinese characters; in that case the parent directory
// is mapped through an ASCII directory junction and the ASCII base name is
// appended. Provider-controlled file names (disk.qcow2, console.log,
// qemu.pid, seed.iso, base images) are ASCII.
func resolveQemuPath(path string, enabled bool, shortener shortPathFunc, dirResolver asciiDirFunc) (string, error) {
	if path == "" || !enabled || isASCII(path) {
		return path, nil
	}
	if shortener != nil {
		if short, err := shortener(path); err == nil && isASCII(short) && short != path {
			return short, nil
		}
	}
	base := filepath.Base(path)
	if !isASCII(base) {
		return "", fmt.Errorf("QEMU cannot open non-ASCII file name %q; no ASCII 8.3 short path is available", base)
	}
	if dirResolver == nil {
		return "", fmt.Errorf("QEMU path %q contains non-ASCII characters and no ASCII short path or directory resolver is available", path)
	}
	parent, err := dirResolver(filepath.Dir(path))
	if err != nil {
		return "", fmt.Errorf("QEMU path %q contains non-ASCII characters and no ASCII short path or junction is available: %w", path, err)
	}
	resolved := filepath.Join(parent, base)
	if !isASCII(resolved) {
		return "", fmt.Errorf("QEMU path %q is still non-ASCII after resolution (%q)", path, resolved)
	}
	return resolved, nil
}

// resolveQemuDirPath is the directory variant used for -L and the QEMU working
// directory. A non-ASCII directory is converted with GetShortPathNameW or an
// ASCII junction.
func resolveQemuDirPath(path string, enabled bool, shortener shortPathFunc, dirResolver asciiDirFunc) (string, error) {
	if path == "" || !enabled || isASCII(path) {
		return path, nil
	}
	if shortener != nil {
		if short, err := shortener(path); err == nil && isASCII(short) && short != path {
			return short, nil
		}
	}
	if dirResolver == nil {
		return "", fmt.Errorf("QEMU directory %q contains non-ASCII characters and no ASCII short path or directory resolver is available", path)
	}
	resolved, err := dirResolver(path)
	if err != nil {
		return "", fmt.Errorf("QEMU directory %q contains non-ASCII characters and no ASCII short path or junction is available: %w", path, err)
	}
	if !isASCII(resolved) {
		return "", fmt.Errorf("QEMU directory %q is still non-ASCII after resolution (%q)", path, resolved)
	}
	return resolved, nil
}
