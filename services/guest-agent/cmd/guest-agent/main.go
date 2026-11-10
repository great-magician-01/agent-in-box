package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"agent-in-box/internal/guestagent"
	"agent-in-box/internal/health"
)

const version = "0.1.0"

func main() {
	addr := flag.String("addr", "127.0.0.1:7611", "guest agent listen address")
	tokenFile := flag.String("token-file", "", "0600 file containing the host-issued guest RPC bearer token")
	display := flag.String("display", os.Getenv("DISPLAY"), "X11 display, for example :0")
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
	rpc := guestagent.NewServer(token, desktop, logger)
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
