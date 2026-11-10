//go:build !windows

package vmprovider

import "fmt"

const qemuNeedsASCIIPathsPlatform = false

func getShortPathName(path string) (string, error) {
	return "", fmt.Errorf("GetShortPathNameW is only available on Windows")
}

func asciiDirectory(dir string) (string, error) {
	return dir, nil
}

func cleanupQemuRuntimeJunction(dir string) error {
	return nil
}
