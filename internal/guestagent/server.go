package guestagent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultActionTimeout bounds a single input action when the caller does
	// not request a shorter one.
	defaultActionTimeout = 30 * time.Second
	// hardMaxActionTimeout is the absolute upper bound. The ServerOptions value
	// may lower it but can never raise it.
	hardMaxActionTimeout = 30 * time.Second

	defaultMaxUpdateBytes int64 = 128 << 20
	defaultUpdateTimeout        = 2 * time.Minute
)

// Desktop is implemented by the in-guest display driver (X11 first).
type Desktop interface {
	Info(ctx context.Context) (DesktopInfo, error)
	Screenshot(ctx context.Context) (image.Image, error)
	Input(ctx context.Context, request InputRequest) error
	Close() error
}

// ServerOptions configures the guest RPC server. Zero values are safe defaults.
type ServerOptions struct {
	Token string
	// TokenFile enables per-request token rotation and revocation. The path must
	// remain a regular, non-symlink file; read failures fail closed.
	TokenFile     string
	AgentVersion  string
	Desktop       Desktop
	Logger        *slog.Logger
	ActionTimeout time.Duration
	// UpdateDir enables authenticated staged updates when non-empty.
	UpdateDir        string
	MaxUpdateBytes   int64
	UpdateHTTPClient *http.Client
	// VerifyRoots bounds read-only completion evidence to explicit guest roots.
	// When empty, file evidence is rejected rather than silently allowed.
	VerifyRoots []string
	// WorkspaceRoots bounds project workspace archive/restore operations.
	WorkspaceRoots []string
	// MaxWorkspaceArchiveBytes caps both uploaded and downloaded workspace archives.
	MaxWorkspaceArchiveBytes int64
	Now                      func() time.Time
}

// Server exposes authenticated guest desktop RPC over HTTP.
type Server struct {
	token                    string
	tokenFile                string
	agentVersion             string
	desktop                  Desktop
	logger                   *slog.Logger
	actionTimeout            time.Duration
	updateDir                string
	maxUpdateBytes           int64
	updateTimeout            time.Duration
	updateHTTPClient         *http.Client
	verifyRoots              []string
	workspaceRoots           []string
	maxWorkspaceArchiveBytes int64
	startedAt                time.Time
	now                      func() time.Time
	actions                  *actionTracker
}

// NewServer preserves the original constructor for existing callers. The
// capabilities endpoint reports the protocol version until a build version is
// supplied through NewServerWithOptions.
func NewServer(token string, desktop Desktop, logger *slog.Logger) *Server {
	return NewServerWithOptions(ServerOptions{Token: token, Desktop: desktop, Logger: logger})
}

// NewServerWithOptions builds a server with an explicit build version and
// bounded action/update behavior.
func NewServerWithOptions(options ServerOptions) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	agentVersion := strings.TrimSpace(options.AgentVersion)
	if agentVersion == "" {
		agentVersion = protocolVersion
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	actionTimeout := options.ActionTimeout
	if actionTimeout <= 0 {
		actionTimeout = defaultActionTimeout
	}
	if actionTimeout > hardMaxActionTimeout {
		actionTimeout = hardMaxActionTimeout
	}
	maxUpdateBytes := options.MaxUpdateBytes
	if maxUpdateBytes <= 0 {
		maxUpdateBytes = defaultMaxUpdateBytes
	}
	maxWorkspaceArchiveBytes := options.MaxWorkspaceArchiveBytes
	if maxWorkspaceArchiveBytes <= 0 || maxWorkspaceArchiveBytes > defaultMaxWorkspaceArchiveBytes {
		maxWorkspaceArchiveBytes = defaultMaxWorkspaceArchiveBytes
	}
	return &Server{
		token:                    options.Token,
		tokenFile:                strings.TrimSpace(options.TokenFile),
		agentVersion:             agentVersion,
		desktop:                  options.Desktop,
		logger:                   logger,
		actionTimeout:            actionTimeout,
		updateDir:                strings.TrimSpace(options.UpdateDir),
		maxUpdateBytes:           maxUpdateBytes,
		updateTimeout:            defaultUpdateTimeout,
		updateHTTPClient:         options.UpdateHTTPClient,
		verifyRoots:              normalizeVerifyRoots(options.VerifyRoots),
		workspaceRoots:           normalizeVerifyRoots(options.WorkspaceRoots),
		maxWorkspaceArchiveBytes: maxWorkspaceArchiveBytes,
		startedAt:                now(),
		now:                      now,
		actions:                  newActionTracker(now),
	}
}

func normalizeVerifyRoots(roots []string) []string {
	normalized := make([]string, 0, len(roots))
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		cleaned := filepath.Clean(root)
		// Reject filesystem roots ("/" or "C:\") as evidence roots.
		if !filepath.IsAbs(cleaned) || filepath.Dir(cleaned) == cleaned {
			continue
		}
		normalized = append(normalized, cleaned)
	}
	return normalized
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/capabilities", s.capabilities)
	mux.HandleFunc("GET /v1/heartbeat", s.heartbeat)
	mux.HandleFunc("GET /v1/version", s.versionHandshake)
	mux.HandleFunc("GET /v1/desktop", s.desktopInfo)
	mux.HandleFunc("GET /v1/screenshot", s.screenshot)
	mux.HandleFunc("POST /v1/input", s.input)
	mux.HandleFunc("POST /v1/verify", s.verify)
	mux.HandleFunc("POST /v1/update", s.update)
	mux.HandleFunc("GET /v1/workspace/archive", s.archiveWorkspace)
	mux.HandleFunc("POST /v1/workspace/restore", s.restoreWorkspace)
	return s.authenticate(mux)
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actionID, _ := parseActionIDHeader(r)
		token, err := s.authenticationToken()
		if err != nil || token == "" {
			writeActionError(w, http.StatusServiceUnavailable, actionID, "unavailable", "guest authentication token is not configured")
			return
		}
		expected := "Bearer " + token
		provided := r.Header.Get("Authorization")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeActionError(w, http.StatusUnauthorized, actionID, "unauthorized", "invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authenticationToken() (string, error) {
	if s.tokenFile == "" {
		return s.token, nil
	}
	info, err := os.Lstat(s.tokenFile)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
		return "", errors.New("guest token file must be a small regular file")
	}
	data, err := os.ReadFile(s.tokenFile)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	capabilities := Capabilities{
		ProtocolVersion: protocolVersion,
		AgentVersion:    s.agentVersion,
		Platform:        runtime.GOOS,
	}
	if s.desktop != nil {
		info, err := s.desktop.Info(r.Context())
		if err == nil {
			capabilities.DisplayServer = info.DisplayServer
			capabilities.SessionState = info.SessionState
			capabilities.Screenshot = true
			capabilities.Input = true
			capabilities.UnicodeInput = info.DisplayServer == "x11" || info.DisplayServer == "windows"
		}
	}
	writeJSON(w, http.StatusOK, capabilities)
}

func (s *Server) versionHandshake(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, versionInfo(s.agentVersion, strings.TrimSpace(r.URL.Query().Get("protocolVersion"))))
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	requested := strings.TrimSpace(r.URL.Query().Get("protocolVersion"))
	compatible, compatibilityError := protocolCompatibility(requested)
	now := s.now()
	heartbeat := Heartbeat{
		Status:                   "ok",
		AgentVersion:             s.agentVersion,
		ProtocolVersion:          protocolVersion,
		Compatible:               compatible,
		RequestedProtocolVersion: requested,
		CompatibilityError:       compatibilityError,
		DesktopAvailable:         s.desktop != nil,
		Platform:                 runtime.GOOS,
		UptimeSeconds:            int64(now.Sub(s.startedAt) / time.Second),
		Now:                      now.UTC().Format(time.RFC3339Nano),
	}
	if heartbeat.UptimeSeconds < 0 {
		heartbeat.UptimeSeconds = 0
	}
	if s.desktop == nil {
		heartbeat.Status = "degraded"
		heartbeat.DesktopError = "no guest desktop driver"
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		info, err := s.desktop.Info(ctx)
		if err != nil {
			heartbeat.Status = "degraded"
			heartbeat.DesktopError = err.Error()
		} else {
			heartbeat.DisplayServer = info.DisplayServer
			heartbeat.SessionState = info.SessionState
			switch info.SessionState {
			case "locked", "secure_desktop":
				heartbeat.Status = "degraded"
				heartbeat.DesktopError = "交互桌面被锁屏或安全桌面占用；需要人工接管"
			}
		}
	}
	writeJSON(w, http.StatusOK, heartbeat)
}

func (s *Server) desktopInfo(w http.ResponseWriter, r *http.Request) {
	if s.desktop == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "no guest desktop driver")
		return
	}
	info, err := s.desktop.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "desktop_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) screenshot(w http.ResponseWriter, r *http.Request) {
	if s.desktop == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "no guest desktop driver")
		return
	}
	capture, err := s.desktop.Screenshot(r.Context())
	if err != nil {
		if status, code := sessionBoundaryError(err); status != 0 {
			writeError(w, status, code, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "screenshot_failed", err.Error())
		return
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, capture); err != nil {
		writeError(w, http.StatusInternalServerError, "screenshot_failed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(ActionIDHeader, newActionID())
	w.Header().Set("X-Agent-In-Box-Width", strconv.Itoa(capture.Bounds().Dx()))
	w.Header().Set("X-Agent-In-Box-Height", strconv.Itoa(capture.Bounds().Dy()))
	_, _ = w.Write(buffer.Bytes())
}

func (s *Server) input(w http.ResponseWriter, r *http.Request) {
	headerID, headerError := parseActionIDHeader(r)
	if headerError != "" {
		writeActionError(w, http.StatusBadRequest, "", "invalid_action_id", headerError)
		return
	}

	var request InputRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
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
	request.ActionID = actionID

	requestedTimeout, timeoutError := timeoutFromRequest(r, request.TimeoutMillis)
	if timeoutError != "" {
		writeActionError(w, http.StatusBadRequest, actionID, "invalid_timeout", timeoutError)
		return
	}
	timeout := s.effectiveActionTimeout(requestedTimeout)

	if s.desktop == nil {
		writeJSON(w, http.StatusServiceUnavailable, ActionResult{
			ActionID:  actionID,
			OK:        false,
			Error:     "no guest desktop driver",
			ErrorCode: "unavailable",
		})
		return
	}
	if !s.actions.reserve(actionID) {
		writeJSON(w, http.StatusConflict, ActionResult{
			ActionID:  actionID,
			OK:        false,
			Error:     "action id has already been used",
			ErrorCode: "duplicate_action_id",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	started := time.Now()
	inputError := s.desktop.Input(ctx, request)
	elapsed := time.Since(started)
	s.logger.Info("guest input action",
		"actionId", actionID,
		"type", request.Type,
		"ok", inputError == nil,
		"timeoutMs", timeout.Milliseconds(),
		"durationMs", elapsed.Milliseconds(),
	)
	if inputError != nil || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		if errors.Is(inputError, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeJSON(w, http.StatusRequestTimeout, ActionResult{
				ActionID:  actionID,
				OK:        false,
				Error:     "action exceeded the server timeout",
				ErrorCode: "action_timeout",
			})
			return
		}
	}
	if inputError != nil {
		if status, code := sessionBoundaryError(inputError); status != 0 {
			writeJSON(w, status, ActionResult{
				ActionID:  actionID,
				OK:        false,
				Error:     inputError.Error(),
				ErrorCode: code,
			})
			return
		}
		writeJSON(w, http.StatusBadRequest, ActionResult{
			ActionID:  actionID,
			OK:        false,
			Error:     inputError.Error(),
			ErrorCode: "action_failed",
		})
		return
	}
	writeJSON(w, http.StatusOK, ActionResult{ActionID: actionID, OK: true})
}

func (s *Server) effectiveActionTimeout(requested time.Duration) time.Duration {
	timeout := requested
	if timeout <= 0 {
		timeout = s.actionTimeout
	}
	if timeout > s.actionTimeout {
		timeout = s.actionTimeout
	}
	if timeout <= 0 {
		timeout = defaultActionTimeout
	}
	return timeout
}

// sessionBoundaryError maps an unavailable interactive session to a stable
// error code. The host treats these as human-takeover conditions and does not
// retry the desktop action.
func sessionBoundaryError(err error) (int, string) {
	switch {
	case errors.Is(err, ErrSessionLocked):
		return http.StatusLocked, "session_locked"
	case errors.Is(err, ErrSecureDesktop):
		return http.StatusLocked, "secure_desktop"
	default:
		return 0, ""
	}
}

func newActionID() string {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(value[:])
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeActionError(w, status, "", code, message)
}

func writeActionError(w http.ResponseWriter, status int, actionID string, code string, message string) {
	payload := map[string]any{
		"ok":    false,
		"error": map[string]string{"code": code, "message": message},
	}
	if actionID != "" {
		payload["actionId"] = actionID
	}
	writeJSON(w, status, payload)
}
