// Package vmsupervisor exposes the loopback, ACL-protected HTTP management API
// used by the control plane. It only calls the fixed vmprovider.Provider
// operations; it never exposes an arbitrary command endpoint.
package vmsupervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"agent-in-box/internal/health"
	"agent-in-box/internal/vmprovider"
)

const (
	vmMetadataFilename = "vm.json"

	defaultMaxBodyBytes   = 1 << 20
	defaultCreateTimeout  = 90 * time.Second
	defaultStartTimeout   = 90 * time.Second
	defaultStopTimeout    = 90 * time.Second
	defaultSuspendTimeout = 30 * time.Second
	defaultResumeTimeout  = 30 * time.Second
	defaultStateTimeout   = 10 * time.Second
	defaultConsoleTimeout = 10 * time.Second
	defaultListTimeout    = 30 * time.Second
	defaultHostTimeout    = 20 * time.Second
	smallBodyBytes        = 64 << 10
	emptyBodyBytes        = 4 << 10
)

// Config wires the supervisor HTTP surface to a provider.
type Config struct {
	StorageRoot string
	Provider    vmprovider.Provider
	Token       string
	Logger      *slog.Logger

	ServiceName string
	Version     string

	// HostInspector defaults to vmprovider.InspectHost using QemuConfig.
	HostInspector func(context.Context) vmprovider.HostInspection
	QemuConfig    vmprovider.QemuConfig

	MaxBodyBytes int64

	CreateTimeout  time.Duration
	StartTimeout   time.Duration
	StopTimeout    time.Duration
	SuspendTimeout time.Duration
	ResumeTimeout  time.Duration
	StateTimeout   time.Duration
	ConsoleTimeout time.Duration
	ListTimeout    time.Duration
	HostTimeout    time.Duration
}

// Server implements the local supervisor API.
type Server struct {
	config         Config
	logger         *slog.Logger
	health         http.Handler
	inspectHost    func(context.Context) vmprovider.HostInspection
	maxBodyBytes   int64
	createTimeout  time.Duration
	startTimeout   time.Duration
	stopTimeout    time.Duration
	suspendTimeout time.Duration
	resumeTimeout  time.Duration
	stateTimeout   time.Duration
	consoleTimeout time.Duration
	listTimeout    time.Duration
	hostTimeout    time.Duration
}

// New validates the configuration and builds the supervisor handler.
func New(config Config) (*Server, error) {
	if config.Provider == nil {
		return nil, errors.New("vm provider is required")
	}
	if strings.TrimSpace(config.StorageRoot) == "" {
		return nil, errors.New("storage root is required")
	}
	if strings.TrimSpace(config.Token) == "" {
		return nil, errors.New("acl token is required")
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	if config.ServiceName == "" {
		config.ServiceName = "vm-supervisor"
	}
	if config.Version == "" {
		config.Version = "dev"
	}

	server := &Server{
		config:         config,
		logger:         config.Logger,
		health:         health.NewHandler(config.ServiceName, config.Version),
		inspectHost:    config.HostInspector,
		maxBodyBytes:   config.MaxBodyBytes,
		createTimeout:  config.CreateTimeout,
		startTimeout:   config.StartTimeout,
		stopTimeout:    config.StopTimeout,
		suspendTimeout: config.SuspendTimeout,
		resumeTimeout:  config.ResumeTimeout,
		stateTimeout:   config.StateTimeout,
		consoleTimeout: config.ConsoleTimeout,
		listTimeout:    config.ListTimeout,
		hostTimeout:    config.HostTimeout,
	}
	if server.maxBodyBytes <= 0 {
		server.maxBodyBytes = defaultMaxBodyBytes
	}
	server.createTimeout = durationOrDefault(server.createTimeout, defaultCreateTimeout)
	server.startTimeout = durationOrDefault(server.startTimeout, defaultStartTimeout)
	server.stopTimeout = durationOrDefault(server.stopTimeout, defaultStopTimeout)
	server.suspendTimeout = durationOrDefault(server.suspendTimeout, defaultSuspendTimeout)
	server.resumeTimeout = durationOrDefault(server.resumeTimeout, defaultResumeTimeout)
	server.stateTimeout = durationOrDefault(server.stateTimeout, defaultStateTimeout)
	server.consoleTimeout = durationOrDefault(server.consoleTimeout, defaultConsoleTimeout)
	server.listTimeout = durationOrDefault(server.listTimeout, defaultListTimeout)
	server.hostTimeout = durationOrDefault(server.hostTimeout, defaultHostTimeout)

	if server.inspectHost == nil {
		qemuConfig := config.QemuConfig
		qemuConfig.StorageRoot = config.StorageRoot
		if qemuConfig.SystemBinary == "" {
			qemuConfig.SystemBinary = "qemu-system-x86_64"
		}
		server.inspectHost = func(ctx context.Context) vmprovider.HostInspection {
			return vmprovider.InspectHost(ctx, qemuConfig)
		}
	}
	return server, nil
}

func durationOrDefault(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return value
}

// Handler returns the root HTTP handler. Server itself implements http.Handler.
func (s *Server) Handler() http.Handler {
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if recovered := recover(); recovered != nil {
			s.logger.Error("supervisor request panic",
				"method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(recovered))
			s.writeError(w, http.StatusInternalServerError, codeInternal, "internal error")
		}
	}()

	switch r.URL.Path {
	case "/healthz", "/readyz":
		if r.Method != http.MethodGet {
			s.writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed")
			return
		}
		s.health.ServeHTTP(w, r)
		return
	}

	path := r.URL.Path
	if path != "/api/v1" && !strings.HasPrefix(path, "/api/v1/") {
		s.writeError(w, http.StatusNotFound, codeNotFound, "route not found")
		return
	}
	if !s.authorized(r) {
		s.logger.Warn("supervisor request rejected", "operation", "auth", "method", r.Method, "path", path)
		w.Header().Set("WWW-Authenticate", `Bearer realm="vm-supervisor"`)
		s.writeError(w, http.StatusUnauthorized, codeUnauthorized, "missing or invalid bearer token")
		return
	}

	switch path {
	case "/api/v1/host":
		s.handleHost(w, r)
		return
	case "/api/v1/vms":
		s.handleVmsCollection(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/v1/vms/") {
		s.handleVmResource(w, r, strings.TrimPrefix(path, "/api/v1/vms/"))
		return
	}
	s.writeError(w, http.StatusNotFound, codeNotFound, "route not found")
}

func (s *Server) authorized(r *http.Request) bool {
	provided, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return false
	}
	return tokenMatches(s.config.Token, provided)
}

func (s *Server) handleHost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w, http.MethodGet)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.hostTimeout)
	defer cancel()
	inspection := s.inspectHost(ctx)
	s.logger.Info("host inspection completed", "operation", "host", "ready", inspection.Ready)
	s.writeJSON(w, http.StatusOK, inspection)
}

func (s *Server) handleVmsCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListVms(w, r)
	case http.MethodPost:
		s.handleCreateVm(w, r)
	default:
		s.methodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (s *Server) handleVmResource(w http.ResponseWriter, r *http.Request, resource string) {
	segments := strings.Split(resource, "/")
	if len(segments) == 0 || segments[0] == "" {
		s.writeError(w, http.StatusNotFound, codeNotFound, "vm not found")
		return
	}
	vmID := segments[0]
	switch len(segments) {
	case 1:
		if r.Method != http.MethodGet {
			s.methodNotAllowed(w, http.MethodGet)
			return
		}
		s.handleGetVm(w, r, vmID)
	case 2:
		switch segments[1] {
		case "start":
			if r.Method != http.MethodPost {
				s.methodNotAllowed(w, http.MethodPost)
				return
			}
			s.handleStartVm(w, r, vmID)
		case "stop":
			if r.Method != http.MethodPost {
				s.methodNotAllowed(w, http.MethodPost)
				return
			}
			s.handleStopVm(w, r, vmID)
		case "suspend":
			if r.Method != http.MethodPost {
				s.methodNotAllowed(w, http.MethodPost)
				return
			}
			s.handleSuspendVm(w, r, vmID)
		case "resume":
			if r.Method != http.MethodPost {
				s.methodNotAllowed(w, http.MethodPost)
				return
			}
			s.handleResumeVm(w, r, vmID)
		case "console":
			if r.Method != http.MethodGet {
				s.methodNotAllowed(w, http.MethodGet)
				return
			}
			s.handleConsole(w, r, vmID)
		default:
			s.writeError(w, http.StatusNotFound, codeNotFound, "route not found")
		}
	default:
		s.writeError(w, http.StatusNotFound, codeNotFound, "route not found")
	}
}

func (s *Server) handleListVms(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.listTimeout)
	defer cancel()
	items, err := s.listVms(ctx)
	if err != nil {
		s.logger.Error("list vms failed", "operation", "list", "error", err)
		status, code, message := classifyError(err)
		s.writeError(w, status, code, message)
		return
	}
	s.logger.Info("vm list reconciled", "operation", "list", "count", len(items))
	s.writeJSON(w, http.StatusOK, struct {
		Items []vmprovider.VmState `json:"items"`
	}{Items: items})
}

// listVms scans direct children of the storage root. Directories without
// vm.json, or whose provider reconciliation fails, are logged and skipped so a
// single damaged VM cannot break the entire list call.
func (s *Server) listVms(ctx context.Context) ([]vmprovider.VmState, error) {
	entries, err := os.ReadDir(s.config.StorageRoot)
	if errors.Is(err, os.ErrNotExist) {
		return []vmprovider.VmState{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read vm storage root: %w", err)
	}
	items := make([]vmprovider.VmState, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		vmID := entry.Name()
		metadataPath := filepath.Join(s.config.StorageRoot, vmID, vmMetadataFilename)
		info, statErr := os.Stat(metadataPath)
		if statErr != nil {
			s.logger.Warn("skipping vm directory without readable metadata",
				"operation", "list", "vm", vmID, "error", statErr)
			continue
		}
		if info.IsDir() {
			s.logger.Warn("skipping vm with directory metadata file",
				"operation", "list", "vm", vmID, "error", "vm.json is a directory")
			continue
		}
		stateCtx, cancel := context.WithTimeout(ctx, s.stateTimeout)
		state, stateErr := s.config.Provider.GetVmState(stateCtx, vmID)
		cancel()
		if stateErr != nil {
			s.logger.Warn("skipping vm during list reconciliation",
				"operation", "list", "vm", vmID, "error", stateErr)
			continue
		}
		items = append(items, state)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

func (s *Server) handleCreateVm(w http.ResponseWriter, r *http.Request) {
	var spec vmprovider.VmSpec
	if err := s.decodeJSON(w, r, s.maxBodyBytes, false, &spec); err != nil {
		s.writeRequestError(w, "create", spec.ID, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.createTimeout)
	defer cancel()
	state, err := s.config.Provider.CreateVm(ctx, spec)
	s.writeVmState(w, "create", spec.ID, state, err, http.StatusCreated)
}

func (s *Server) handleGetVm(w http.ResponseWriter, r *http.Request, vmID string) {
	ctx, cancel := context.WithTimeout(r.Context(), s.stateTimeout)
	defer cancel()
	state, err := s.config.Provider.GetVmState(ctx, vmID)
	s.writeVmState(w, "state", vmID, state, err, http.StatusOK)
}

func (s *Server) handleStartVm(w http.ResponseWriter, r *http.Request, vmID string) {
	if err := s.decodeJSON(w, r, emptyBodyBytes, true, &struct{}{}); err != nil {
		s.writeRequestError(w, "start", vmID, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.startTimeout)
	defer cancel()
	state, err := s.config.Provider.StartVm(ctx, vmID)
	s.writeVmState(w, "start", vmID, state, err, http.StatusOK)
}

func (s *Server) handleStopVm(w http.ResponseWriter, r *http.Request, vmID string) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := s.decodeJSON(w, r, smallBodyBytes, true, &body); err != nil {
		s.writeRequestError(w, "stop", vmID, err)
		return
	}
	mode := body.Mode
	if mode == "" {
		mode = "graceful"
	}
	if mode != "graceful" && mode != "force" {
		s.writeRequestError(w, "stop", vmID,
			newRequestError(http.StatusBadRequest, codeInvalidSpec, `stop mode must be "graceful" or "force"`))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.stopTimeout)
	defer cancel()
	state, err := s.config.Provider.StopVm(ctx, vmID, mode)
	s.writeVmState(w, "stop", vmID, state, err, http.StatusOK)
}

func (s *Server) handleSuspendVm(w http.ResponseWriter, r *http.Request, vmID string) {
	if err := s.decodeJSON(w, r, emptyBodyBytes, true, &struct{}{}); err != nil {
		s.writeRequestError(w, "suspend", vmID, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.suspendTimeout)
	defer cancel()
	state, err := s.config.Provider.SuspendVm(ctx, vmID)
	s.writeVmState(w, "suspend", vmID, state, err, http.StatusOK)
}

func (s *Server) handleResumeVm(w http.ResponseWriter, r *http.Request, vmID string) {
	if err := s.decodeJSON(w, r, emptyBodyBytes, true, &struct{}{}); err != nil {
		s.writeRequestError(w, "resume", vmID, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.resumeTimeout)
	defer cancel()
	state, err := s.config.Provider.ResumeVm(ctx, vmID)
	s.writeVmState(w, "resume", vmID, state, err, http.StatusOK)
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request, vmID string) {
	ctx, cancel := context.WithTimeout(r.Context(), s.consoleTimeout)
	defer cancel()
	consoleURL, err := s.config.Provider.AttachConsole(ctx, vmID)
	if err != nil {
		s.logOperationError(w, "console", vmID, err)
		return
	}
	s.logger.Info("vm operation completed", "operation", "console", "vm", vmID)
	s.writeJSON(w, http.StatusOK, struct {
		ConsoleURL string `json:"consoleUrl"`
	}{ConsoleURL: consoleURL})
}

func (s *Server) writeVmState(w http.ResponseWriter, operation, vmID string, state vmprovider.VmState, err error, successStatus int) {
	if err != nil {
		s.logOperationError(w, operation, vmID, err)
		return
	}
	s.logger.Info("vm operation completed",
		"operation", operation, "vm", vmID, "powerState", state.PowerState)
	s.writeJSON(w, successStatus, state)
}

func (s *Server) logOperationError(w http.ResponseWriter, operation, vmID string, err error) {
	status, code, message := classifyError(err)
	level := slog.LevelWarn
	if status >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	s.logger.Log(context.Background(), level, "vm operation failed",
		"operation", operation, "vm", vmID, "status", status, "error", err)
	s.writeError(w, status, code, message)
}

func (s *Server) writeRequestError(w http.ResponseWriter, operation, vmID string, err error) {
	status, code, message := classifyError(err)
	s.logger.Warn("supervisor request rejected",
		"operation", operation, "vm", vmID, "status", status, "error", err)
	s.writeError(w, status, code, message)
}

func (s *Server) methodNotAllowed(w http.ResponseWriter, allowed ...string) {
	w.Header().Set("Allow", strings.Join(allowed, ", "))
	s.writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed")
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message string) {
	s.writeJSON(w, status, apiErrorResponse{
		OK:    false,
		Error: apiErrorBody{Code: code, Message: message},
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		s.logger.Error("encode supervisor response", "error", err)
	}
}

// decodeJSON enforces a body limit, unknown-field rejection and a single JSON
// object. When allowEmpty is true, an empty body leaves dest at its defaults.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, allowEmpty bool, dest any) error {
	if limit <= 0 || limit > s.maxBodyBytes {
		limit = s.maxBodyBytes
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return newRequestError(http.StatusRequestEntityTooLarge, codeInvalidRequest,
				fmt.Sprintf("request body exceeds %d bytes", limit))
		}
		return invalidRequest("could not read request body")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		if allowEmpty {
			return nil
		}
		return invalidRequest("request body is required")
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return invalidRequest("invalid JSON body: " + err.Error())
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return invalidRequest("request body must contain a single JSON object")
	}
	return nil
}
