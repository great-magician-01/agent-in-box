package vmsupervisor

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"agent-in-box/internal/securefile"
)

const (
	// ACLTokenFileEnv overrides the default token file location.
	ACLTokenFileEnv = "AGENT_IN_BOX_SUPERVISOR_TOKEN_FILE"
	// ACLTokenEnv is a development/test-only in-memory token override. A token
	// file always wins when it exists so production deployments stay file-backed.
	ACLTokenEnv = "AGENT_IN_BOX_SUPERVISOR_TOKEN"

	defaultACLTokenFilename    = "supervisor-acl.token"
	minimumGeneratedTokenBytes = 32
)

// TokenOptions resolves the supervisor ACL token. File is the explicit
// -acl-token-file value (empty means derive it from storageRoot).
type TokenOptions struct {
	File        string
	StorageRoot string
	// Getenv defaults to os.Getenv when nil.
	Getenv func(string) string
}

// TokenResult reports the token and the file path it was read from or written
// to. The token itself must never be logged.
type TokenResult struct {
	Token string
	Path  string
}

// DefaultACLTokenPath derives <storage-root>/../supervisor-acl.token.
func DefaultACLTokenPath(storageRoot string) string {
	parent := filepath.Dir(filepath.Clean(storageRoot))
	return filepath.Join(parent, defaultACLTokenFilename)
}

// ResolveACLToken reads, or safely generates, the local supervisor ACL token.
// Precedence is: existing token file, explicit development env token, newly
// generated 32-byte random token written atomically with 0600 permissions.
func ResolveACLToken(options TokenOptions) (TokenResult, error) {
	getenv := options.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}

	path := options.File
	if path == "" {
		if envFile := strings.TrimSpace(getenv(ACLTokenFileEnv)); envFile != "" {
			path = envFile
		} else {
			if options.StorageRoot == "" {
				return TokenResult{}, errors.New("storage root is required to derive the acl token path")
			}
			path = DefaultACLTokenPath(options.StorageRoot)
		}
	}

	info, err := os.Lstat(path)
	switch {
	case err == nil:
		if info.Mode()&os.ModeSymlink != 0 {
			return TokenResult{}, fmt.Errorf("acl token file %q is a symlink; refusing to follow it", path)
		}
		if !info.Mode().IsRegular() {
			return TokenResult{}, fmt.Errorf("acl token file %q is not a regular file", path)
		}
		token, err := securefile.ReadToken(path)
		if err != nil {
			return TokenResult{}, fmt.Errorf("read acl token file %q: %w", path, err)
		}
		return TokenResult{Token: token, Path: path}, nil
	case errors.Is(err, os.ErrNotExist):
		if token := strings.TrimSpace(getenv(ACLTokenEnv)); token != "" {
			return TokenResult{Token: token, Path: path}, nil
		}
		token, err := generateACLToken(path)
		if err != nil {
			return TokenResult{}, err
		}
		return TokenResult{Token: token, Path: path}, nil
	default:
		return TokenResult{}, fmt.Errorf("inspect acl token file %q: %w", path, err)
	}
}

func generateACLToken(path string) (string, error) {
	raw := make([]byte, minimumGeneratedTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate acl token: %w", err)
	}
	token := hex.EncodeToString(raw)

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create acl token directory %q: %w", dir, err)
	}
	if err := securefile.InstallTokenAtomically(path, token); err != nil {
		return "", fmt.Errorf("install acl token: %w", err)
	}
	return token, nil
}

// ValidateListenAddress rejects wildcard and non-loopback bind addresses. The
// supervisor must never become reachable from other hosts.
func ValidateListenAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("listen address must be host:port: %w", err)
	}
	if host == "" {
		return fmt.Errorf("listen address %q must bind a loopback interface", address)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return fmt.Errorf("listen address %q has an invalid port", address)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen address %q is not loopback", address)
	}
	return nil
}

func bearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	if token == "" {
		return "", false
	}
	return token, true
}

func tokenMatches(expected, provided string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) == 1
}
