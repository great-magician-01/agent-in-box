package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"agent-in-box/internal/guestagent"
	"agent-in-box/internal/health"
)

// version is the explicit build version reported by /v1/capabilities,
// /v1/version and /v1/heartbeat. Release builds override it with:
//
//	go build -ldflags "-X main.version=<version>"
var version = "0.1.0"

func defaultUpdateDir() string {
	if configDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(configDir) != "" {
		return filepath.Join(configDir, "agent-in-box", "guest-agent", "updates")
	}
	return filepath.Join(os.TempDir(), "agent-in-box-guest-agent-updates")
}

func main() {
	addr := flag.String("addr", "127.0.0.1:7611", "guest agent listen address")
	tokenFile := flag.String("token-file", "", "0600 file containing the host-issued guest RPC bearer token")
	display := flag.String("display", os.Getenv("DISPLAY"), "X11 display, for example :0")
	actionTimeout := flag.Duration("action-timeout", 30*time.Second, "maximum time allowed for one input action (capped at 30s)")
	updateDir := flag.String("update-dir", defaultUpdateDir(), "directory for verified staged updates; empty disables update staging")
	maxUpdateBytes := flag.Int64("update-max-bytes", 128<<20, "largest guest-agent update that may be staged")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	token := ""
	if *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if err != nil {
			logger.Error("read guest token", "error", err)
			os.Exit(1)
		}
		token = strings.TrimSpace(string(data))
	}

	desktop, err := guestagent.NewDesktop(*display)
	if err != nil {
		logger.Warn("guest desktop is unavailable; screenshot and input stay disabled", "error", err)
		desktop = nil
	}
	if desktop != nil {
		defer desktop.Close()
	}

	healthHandler := health.NewHandler("guest-agent", version)
	rpc := guestagent.NewServerWithOptions(guestagent.ServerOptions{
		Token:          token,
		TokenFile:      *tokenFile,
		AgentVersion:   version,
		Desktop:        desktop,
		Logger:         logger,
		ActionTimeout:  *actionTimeout,
		UpdateDir:      *updateDir,
		MaxUpdateBytes: *maxUpdateBytes,
	})
	mux := http.NewServeMux()
	mux.Handle("/healthz", healthHandler)
	mux.Handle("/readyz", healthHandler)
	mux.Handle("/v1/", rpc.Handler())

	server := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("guest-agent listening", "addr", *addr, "version", version)
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("guest-agent stopped unexpectedly", "error", err)
			os.Exit(1)
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("guest-agent shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("guest-agent stopped")
}
