package guestagent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

const protocolVersion = "0.1.0"

// Desktop is implemented by the in-guest display driver (X11 first).
type Desktop interface {
	Info(ctx context.Context) (DesktopInfo, error)
	Screenshot(ctx context.Context) (image.Image, error)
	Input(ctx context.Context, request InputRequest) error
	Close() error
}

// Server exposes authenticated guest desktop RPC over HTTP.
type Server struct {
	token   string
	desktop Desktop
	logger  *slog.Logger
}

func NewServer(token string, desktop Desktop, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{token: token, desktop: desktop, logger: logger}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/capabilities", s.capabilities)
	mux.HandleFunc("GET /v1/desktop", s.desktopInfo)
	mux.HandleFunc("GET /v1/screenshot", s.screenshot)
	mux.HandleFunc("POST /v1/input", s.input)
	return s.authenticate(mux)
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.token == "" {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "guest authentication token is not configured")
			return
		}
		expected := "Bearer " + s.token
		provided := r.Header.Get("Authorization")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	capabilities := Capabilities{ProtocolVersion: protocolVersion}
	if s.desktop != nil {
		info, err := s.desktop.Info(r.Context())
		if err == nil {
			capabilities.DisplayServer = info.DisplayServer
			capabilities.Screenshot = true
			capabilities.Input = true
			capabilities.UnicodeInput = info.DisplayServer == "x11"
		}
	}
	writeJSON(w, http.StatusOK, capabilities)
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
	w.Header().Set("X-Agent-In-Box-Action-Id", newActionID())
	w.Header().Set("X-Agent-In-Box-Width", strconv.Itoa(capture.Bounds().Dx()))
	w.Header().Set("X-Agent-In-Box-Height", strconv.Itoa(capture.Bounds().Dy()))
	_, _ = w.Write(buffer.Bytes())
}

func (s *Server) input(w http.ResponseWriter, r *http.Request) {
	actionID := newActionID()
	if s.desktop == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "no guest desktop driver")
		return
	}
	var request InputRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	started := time.Now()
	err := s.desktop.Input(r.Context(), request)
	s.logger.Info("guest input action",
		"actionId", actionID,
		"type", request.Type,
		"ok", err == nil,
		"durationMs", time.Since(started).Milliseconds(),
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, ActionResult{ActionID: actionID, OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, ActionResult{ActionID: actionID, OK: true})
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
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": map[string]string{"code": code, "message": message},
	})
}
