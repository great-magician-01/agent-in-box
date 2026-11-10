package guestagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const (
	maxUpdateManifestBytes int64 = 64 << 10
	maxUpdateRedirects           = 5
	maxUpdateURLLength           = 2048
	updateActivation             = "external_service_manager"
)

var (
	updateVersionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`)
	sha256Pattern        = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
)

type updateValidationError struct {
	code    string
	message string
}

func (e *updateValidationError) Error() string { return e.message }

type updateStageError struct {
	status  int
	code    string
	message string
}

func (e *updateStageError) Error() string { return e.message }

// update handles authenticated staging of a verified guest-agent build. It
// never executes the downloaded file and never restarts the agent.
func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	headerID, headerError := parseActionIDHeader(r)
	if headerError != "" {
		writeActionError(w, http.StatusBadRequest, "", "invalid_action_id", headerError)
		return
	}

	var manifest UpdateManifest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxUpdateManifestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		writeActionError(w, http.StatusBadRequest, headerID, "bad_request", err.Error())
		return
	}

	actionID, mergeError := mergeActionID(headerID, manifest.ActionID)
	if mergeError != "" {
		writeActionError(w, http.StatusBadRequest, headerID, "invalid_action_id", mergeError)
		return
	}
	if actionID == "" {
		actionID = newActionID()
	}
	manifest.ActionID = actionID

	compatibility := newUpdateCompatibility(manifest)
	targetURL, validationError := validateUpdateManifest(&manifest, &compatibility, s.maxUpdateBytes)
	if validationError != nil {
		status := http.StatusBadRequest
		if validationError.code == "update_too_large" {
			status = http.StatusRequestEntityTooLarge
		}
		writeUpdateError(w, status, actionID, validationError.code, validationError.Error(), compatibility)
		return
	}
	if !compatibility.Compatible {
		writeUpdateError(w, http.StatusConflict, actionID, "incompatible_update",
			strings.Join(compatibility.Reasons, "; "), compatibility)
		return
	}
	if s.updateDir == "" {
		writeUpdateError(w, http.StatusServiceUnavailable, actionID, "updates_unavailable",
			"guest agent update staging is not configured", compatibility)
		return
	}
	if !s.actions.reserve(actionID) {
		writeUpdateError(w, http.StatusConflict, actionID, "duplicate_action_id",
			"action id has already been used", compatibility)
		return
	}

	result, stageError := s.stageUpdate(r.Context(), manifest, targetURL, compatibility)
	if stageError != nil {
		writeUpdateError(w, stageError.status, actionID, stageError.code, stageError.message, compatibility)
		return
	}
	result.ActionID = actionID
	result.OK = true
	result.RestartRequired = true
	result.Activation = updateActivation
	writeJSON(w, http.StatusOK, result)
}

func newUpdateCompatibility(manifest UpdateManifest) UpdateCompatibility {
	return UpdateCompatibility{
		CurrentProtocolVersion: protocolVersion,
		TargetProtocolVersion:  manifest.ProtocolVersion,
		CurrentOS:              runtime.GOOS,
		TargetOS:               manifest.OS,
		CurrentArchitecture:    runtime.GOARCH,
		TargetArchitecture:     manifest.Architecture,
	}
}

// validateUpdateManifest is intentionally strict: fixed version, size and
// SHA-256 are mandatory, and only HTTPS or loopback HTTP sources are allowed.
func validateUpdateManifest(manifest *UpdateManifest, compatibility *UpdateCompatibility, maxBytes int64) (*url.URL, *updateValidationError) {
	manifest.Version = strings.TrimSpace(manifest.Version)
	if !updateVersionPattern.MatchString(manifest.Version) {
		return nil, &updateValidationError{code: "invalid_manifest", message: "version must match [0-9A-Za-z][0-9A-Za-z._+-]{0,63}"}
	}

	manifest.SHA256 = strings.ToLower(strings.TrimSpace(manifest.SHA256))
	if !sha256Pattern.MatchString(manifest.SHA256) {
		return nil, &updateValidationError{code: "invalid_manifest", message: "sha256 must be exactly 64 hexadecimal characters"}
	}
	if manifest.SizeBytes <= 0 {
		return nil, &updateValidationError{code: "invalid_manifest", message: "sizeBytes must be positive"}
	}
	if manifest.SizeBytes > maxBytes {
		return nil, &updateValidationError{code: "update_too_large", message: fmt.Sprintf("update exceeds the %d byte limit", maxBytes)}
	}

	manifest.URL = strings.TrimSpace(manifest.URL)
	targetURL, err := parseUpdateURL(manifest.URL)
	if err != nil {
		return nil, &updateValidationError{code: "source_forbidden", message: err.Error()}
	}

	manifest.OS = strings.TrimSpace(manifest.OS)
	manifest.Architecture = strings.TrimSpace(manifest.Architecture)
	compatibility.TargetOS = manifest.OS
	compatibility.TargetArchitecture = manifest.Architecture
	if manifest.OS != "" && !strings.EqualFold(manifest.OS, runtime.GOOS) {
		compatibility.Reasons = append(compatibility.Reasons,
			fmt.Sprintf("target OS %s does not match guest OS %s", manifest.OS, runtime.GOOS))
	}
	if manifest.Architecture != "" && !strings.EqualFold(manifest.Architecture, runtime.GOARCH) {
		compatibility.Reasons = append(compatibility.Reasons,
			fmt.Sprintf("target architecture %s does not match guest architecture %s", manifest.Architecture, runtime.GOARCH))
	}

	manifest.ProtocolVersion = strings.TrimSpace(manifest.ProtocolVersion)
	compatibility.TargetProtocolVersion = manifest.ProtocolVersion
	if manifest.ProtocolVersion != "" {
		targetProtocol, ok := parseNumericVersion(manifest.ProtocolVersion)
		if !ok {
			return nil, &updateValidationError{code: "invalid_manifest", message: "protocolVersion must use MAJOR.MINOR.PATCH"}
		}
		currentProtocol, _ := parseNumericVersion(protocolVersion)
		if targetProtocol.major != currentProtocol.major {
			compatibility.Reasons = append(compatibility.Reasons,
				fmt.Sprintf("target protocol %s has a different major version than %s", manifest.ProtocolVersion, protocolVersion))
		}
	}
	compatibility.Compatible = len(compatibility.Reasons) == 0
	return targetURL, nil
}

func parseUpdateURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("update URL is required")
	}
	if len(raw) > maxUpdateURLLength {
		return nil, fmt.Errorf("update URL exceeds %d characters", maxUpdateURLLength)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid update URL: %w", err)
	}
	if err := validateUpdateURL(parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func validateUpdateURL(parsed *url.URL) error {
	if parsed == nil || parsed.Host == "" {
		return errors.New("update URL must be absolute")
	}
	if parsed.User != nil {
		return errors.New("update URL must not contain embedded credentials")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(parsed.Hostname()) {
			return nil
		}
		return fmt.Errorf("plain HTTP is only allowed for loopback update sources, got %s", parsed.Hostname())
	default:
		return fmt.Errorf("update URL must use HTTPS or loopback HTTP, got %s", parsed.Scheme)
	}
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) updateHTTPClientFor(source *url.URL) *http.Client {
	var client http.Client
	if s.updateHTTPClient != nil {
		client = *s.updateHTTPClient
	}
	if client.Timeout <= 0 {
		client.Timeout = s.updateTimeout
	}
	previousRedirect := client.CheckRedirect
	sourceScheme := strings.ToLower(source.Scheme)
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if previousRedirect != nil {
			if err := previousRedirect(request, via); err != nil {
				return err
			}
		}
		if len(via) >= maxUpdateRedirects {
			return fmt.Errorf("refusing more than %d update redirects", maxUpdateRedirects)
		}
		if err := validateUpdateURL(request.URL); err != nil {
			return err
		}
		// Never allow an HTTPS source to downgrade to plain HTTP, even loopback.
		if sourceScheme == "https" && strings.ToLower(request.URL.Scheme) != "https" {
			return errors.New("refusing HTTPS to HTTP redirect for update download")
		}
		return nil
	}
	return &client
}

func (s *Server) stageUpdate(ctx context.Context, manifest UpdateManifest, source *url.URL, compatibility UpdateCompatibility) (UpdateResult, *updateStageError) {
	result := UpdateResult{
		Version:       manifest.Version,
		SizeBytes:     manifest.SizeBytes,
		SHA256:        manifest.SHA256,
		Compatibility: compatibility,
	}
	if err := ensureUpdateDir(s.updateDir); err != nil {
		return result, &updateStageError{status: http.StatusInternalServerError, code: "update_staging_failed", message: err.Error()}
	}

	fileName := fmt.Sprintf("guest-agent-%s-%s.bin", manifest.Version, manifest.SHA256)
	targetPath := filepath.Join(s.updateDir, fileName)
	result.StagedPath = targetPath

	present, err := verifyStagedFile(targetPath, manifest.SizeBytes, manifest.SHA256)
	if err != nil {
		return result, &updateStageError{status: http.StatusConflict, code: "staged_update_conflict", message: err.Error()}
	}
	if present {
		result.AlreadyStaged = true
		return result, nil
	}

	downloadCtx, cancel := context.WithTimeout(ctx, s.updateTimeout)
	defer cancel()

	temp, err := os.CreateTemp(s.updateDir, ".guest-agent-*.partial")
	if err != nil {
		return result, &updateStageError{status: http.StatusInternalServerError, code: "update_staging_failed", message: err.Error()}
	}
	tempPath := temp.Name()
	staged := false
	defer func() {
		if !staged {
			_ = temp.Close()
			_ = os.Remove(tempPath)
		}
	}()

	request, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, source.String(), nil)
	if err != nil {
		return result, &updateStageError{status: http.StatusBadRequest, code: "invalid_manifest", message: err.Error()}
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("Accept-Encoding", "identity")

	response, err := s.updateHTTPClientFor(source).Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(downloadCtx.Err(), context.DeadlineExceeded) {
			return result, &updateStageError{status: http.StatusGatewayTimeout, code: "update_timeout", message: "update download timed out"}
		}
		return result, &updateStageError{status: http.StatusBadGateway, code: "update_fetch_failed", message: err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result, &updateStageError{status: http.StatusBadGateway, code: "update_fetch_failed",
			message: fmt.Sprintf("update source returned HTTP %d", response.StatusCode)}
	}
	if response.ContentLength > manifest.SizeBytes {
		return result, &updateStageError{status: http.StatusUnprocessableEntity, code: "update_size_mismatch",
			message: fmt.Sprintf("update source announced %d bytes, manifest requires %d", response.ContentLength, manifest.SizeBytes)}
	}

	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(response.Body, manifest.SizeBytes+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(downloadCtx.Err(), context.DeadlineExceeded) {
			return result, &updateStageError{status: http.StatusGatewayTimeout, code: "update_timeout", message: "update download timed out"}
		}
		return result, &updateStageError{status: http.StatusBadGateway, code: "update_fetch_failed", message: err.Error()}
	}
	if written != manifest.SizeBytes {
		return result, &updateStageError{status: http.StatusUnprocessableEntity, code: "update_size_mismatch",
			message: fmt.Sprintf("downloaded %d bytes, manifest requires %d", written, manifest.SizeBytes)}
	}
	actualSHA256 := hex.EncodeToString(hasher.Sum(nil))
	if actualSHA256 != manifest.SHA256 {
		return result, &updateStageError{status: http.StatusUnprocessableEntity, code: "update_checksum_mismatch",
			message: "downloaded update does not match the manifest SHA-256"}
	}
	if err := temp.Sync(); err != nil {
		return result, &updateStageError{status: http.StatusInternalServerError, code: "update_staging_failed", message: err.Error()}
	}
	if err := temp.Close(); err != nil {
		return result, &updateStageError{status: http.StatusInternalServerError, code: "update_staging_failed", message: err.Error()}
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return result, &updateStageError{status: http.StatusInternalServerError, code: "update_staging_failed", message: err.Error()}
	}
	staged = true
	return result, nil
}

func ensureUpdateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create update staging directory: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("inspect update staging directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("update staging path is not a real directory")
	}
	return nil
}

// verifyStagedFile reports whether an identical build is already staged. A
// non-regular or mismatched existing file is treated as tampering.
func verifyStagedFile(path string, size int64, expectedSHA256 string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("existing staged update is not a regular file")
	}
	if info.Size() != size {
		return false, errors.New("existing staged update has an unexpected size")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, io.LimitReader(file, size+1)); err != nil {
		return false, err
	}
	if hex.EncodeToString(hasher.Sum(nil)) != expectedSHA256 {
		return false, errors.New("existing staged update has an unexpected SHA-256")
	}
	return true, nil
}

func writeUpdateError(w http.ResponseWriter, status int, actionID, code, message string, compatibility UpdateCompatibility) {
	payload := map[string]any{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
		"compatibility": compatibility,
	}
	if actionID != "" {
		payload["actionId"] = actionID
	}
	writeJSON(w, status, payload)
}
