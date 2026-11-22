// Package securefile reads and installs small local bearer-token files without
// following links or treating portable permission bits as Windows ACLs.
package securefile

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxTokenBytes = 4096

// ReadToken opens a token with operating-system handle semantics, validates the
// opened object (not a path that could be replaced afterwards), and reads a
// bounded, non-empty value.
func ReadToken(path string) (string, error) {
	file, err := openTokenFile(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, MaxTokenBytes+1))
	if err != nil {
		return "", fmt.Errorf("read token file %q: %w", path, err)
	}
	if len(data) == 0 || len(data) > MaxTokenBytes {
		return "", fmt.Errorf("token file %q must contain 1..%d bytes", path, MaxTokenBytes)
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("token file %q is empty", path)
	}
	return token, nil
}

// InstallTokenAtomically creates a private temporary file, applies native token
// protections before writing the secret, and atomically renames it into place.
func InstallTokenAtomically(path, token string) (returnErr error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create token directory %q: %w", dir, err)
	}
	temporary, err := createTokenTemp(dir, ".agent-in-box-token-*.tmp")
	if err != nil {
		return fmt.Errorf("create protected token temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		if returnErr != nil {
			_ = os.Remove(temporaryPath)
		}
	}()

	if _, err := temporary.WriteString(token + "\n"); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync token file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close token file: %w", err)
	}
	if err := replaceTokenFile(temporaryPath, path); err != nil {
		return fmt.Errorf("install token file %q: %w", path, err)
	}
	installed, err := ReadToken(path)
	if err != nil {
		return errors.Join(fmt.Errorf("validate installed token file: %w", err), os.Remove(path))
	}
	if installed != strings.TrimSpace(token) {
		return errors.New("installed token file changed during installation")
	}
	return nil
}
