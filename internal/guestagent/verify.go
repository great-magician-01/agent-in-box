package guestagent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxVerifyBodyBytes   = 64 << 10
	maxVerifyChecks      = 8
	maxVerifyHashBytes   = 256 << 20
	maxVerifyProcessPIDs = 100
)

// verify performs bounded, read-only evidence checks. It never returns file
// contents or follows symlinks, and completion never executes a command.
func (s *Server) verify(w http.ResponseWriter, r *http.Request) {
	headerID, headerError := parseActionIDHeader(r)
	if headerError != "" {
		writeActionError(w, http.StatusBadRequest, "", "invalid_action_id", headerError)
		return
	}
	var request VerifyRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxVerifyBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeActionError(w, http.StatusBadRequest, headerID, "bad_request", err.Error())
		return
	}
	actionID, mergeError := mergeActionID(headerID, request.ActionID)
	if mergeError != "" {
		writeActionError(w, http.StatusBadRequest, headerID, "invalid_action_id", mergeError)
		return
	}
	if actionID == "" {
		actionID = newActionID()
	}
	requestedTimeout, timeoutError := timeoutFromRequest(r, request.TimeoutMillis)
	if timeoutError != "" {
		writeActionError(w, http.StatusBadRequest, actionID, "invalid_timeout", timeoutError)
		return
	}
	if !s.actions.reserve(actionID) {
		writeJSON(w, http.StatusConflict, VerifyResult{
			ActionID: actionID,
			OK:       false,
			Error:    "action id has already been used",
		})
		return
	}
	if len(request.Checks) == 0 || len(request.Checks) > maxVerifyChecks {
		writeJSON(w, http.StatusBadRequest, VerifyResult{
			ActionID: actionID,
			OK:       false,
			Error:    fmt.Sprintf("checks must contain 1..%d items", maxVerifyChecks),
		})
		return
	}
	timeout := s.effectiveActionTimeout(requestedTimeout)
	deadline := time.Now().Add(timeout)
	results := make([]VerifyCheckResult, 0, len(request.Checks))
	allOK := true
	for _, check := range request.Checks {
		if time.Now().After(deadline) {
			results = append(results, VerifyCheckResult{
				Type:      check.Type,
				OK:        false,
				ErrorCode: "verify_timeout",
				Error:     "verification exceeded the server timeout",
			})
			allOK = false
			continue
		}
		result := s.verifyCheck(check)
		if !result.OK {
			allOK = false
		}
		results = append(results, result)
	}
	s.logger.Info("guest verify evidence",
		"actionId", actionID,
		"checks", len(request.Checks),
		"ok", allOK,
	)
	writeJSON(w, http.StatusOK, VerifyResult{ActionID: actionID, OK: allOK, Checks: results})
}

func (s *Server) verifyCheck(check VerifyCheck) VerifyCheckResult {
	switch check.Type {
	case "file":
		return s.verifyFile(check)
	case "process":
		return verifyProcess(check)
	default:
		return VerifyCheckResult{
			Type:      check.Type,
			OK:        false,
			ErrorCode: "unsupported_check",
			Error:     fmt.Sprintf("unsupported verification check %q", check.Type),
		}
	}
}

func (s *Server) verifyFile(check VerifyCheck) VerifyCheckResult {
	result := VerifyCheckResult{Type: "file", Path: check.Path}
	path := strings.TrimSpace(check.Path)
	if path == "" || path != filepath.Clean(path) || !filepath.IsAbs(path) {
		return verifyFailure(result, "invalid_path", "path must be a cleaned absolute guest path")
	}
	if strings.ContainsRune(path, 0) || pathHasParentSegment(path) {
		return verifyFailure(result, "invalid_path", "path must not contain NUL or '..' segments")
	}
	if !s.pathAllowedByRoots(path) {
		return verifyFailure(result, "path_outside_roots", "path is outside the configured verification roots")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return verifyFailure(result, "file_not_found", "file does not exist")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return verifyFailure(result, "symlink_rejected", "symlink evidence is not accepted")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return verifyFailure(result, "file_unreadable", "could not resolve evidence path")
	}
	if !s.pathAllowedByRoots(resolved) {
		return verifyFailure(result, "path_outside_roots", "resolved evidence path is outside the configured verification roots")
	}
	path = resolved
	info, err = os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return verifyFailure(result, "not_regular_file", "evidence path is not a regular file")
	}
	result.SizeBytes = info.Size()
	result.ModifiedAt = info.ModTime().UTC().Format(time.RFC3339Nano)
	if check.SizeBytes != nil && *check.SizeBytes != info.Size() {
		return verifyFailure(result, "size_mismatch", "file size does not match the declared size")
	}
	expected := strings.ToLower(strings.TrimSpace(check.SHA256))
	if expected != "" && !isSHA256Hex(expected) {
		return verifyFailure(result, "invalid_sha256", "sha256 must be 64 hexadecimal characters")
	}
	if expected != "" || info.Size() <= maxVerifyHashBytes {
		hash, err := hashRegularFile(path)
		if err != nil {
			return verifyFailure(result, "file_unreadable", err.Error())
		}
		result.SHA256 = hash
	}
	if expected != "" && result.SHA256 != expected {
		return verifyFailure(result, "sha256_mismatch", "file SHA-256 does not match the declared hash")
	}
	result.OK = true
	return result
}

func (s *Server) pathAllowedByRoots(path string) bool {
	if len(s.verifyRoots) == 0 {
		return false
	}
	for _, root := range s.verifyRoots {
		resolvedRoot := root
		if evaluated, err := filepath.EvalSymlinks(root); err == nil {
			resolvedRoot = evaluated
		}
		relative, err := filepath.Rel(resolvedRoot, path)
		if err != nil || relative == "." || strings.HasPrefix(relative, "..") || filepath.IsAbs(relative) {
			continue
		}
		return true
	}
	return false
}

func verifyFailure(result VerifyCheckResult, code, message string) VerifyCheckResult {
	result.OK = false
	result.ErrorCode = code
	result.Error = message
	return result
}

func hashRegularFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open evidence file: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", fmt.Errorf("hash evidence file: %w", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func isSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func pathHasParentSegment(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}
