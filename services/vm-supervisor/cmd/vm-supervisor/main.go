package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agent-in-box/internal/health"
)

const version = "0.1.0"

func main() {
	addr := flag.String("addr", "127.0.0.1:7610", "loopback address for the supervisor health surface")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &http.Server{
		Addr:              *addr,
		Handler:           health.NewHandler("vm-supervisor", version),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("vm-supervisor listening", "addr", *addr, "version", version)
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("vm-supervisor stopped unexpectedly", "error", err)
			os.Exit(1)
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("vm-supervisor shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("vm-supervisor stopped")
}
