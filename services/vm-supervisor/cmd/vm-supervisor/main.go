package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"agent-in-box/internal/health"
	"agent-in-box/internal/vmprovider"
)

const version = "0.1.0"

func defaultStorageRoot() string {
	if root := os.Getenv("AGENT_IN_BOX_DATA_ROOT"); root != "" {
		return filepath.Join(root, "vms")
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return "vms"
	}
	return filepath.Join(localAppData, "AgentInBox", "vms")
}

func main() {
	addr := flag.String("addr", "127.0.0.1:7610", "loopback address for the supervisor health surface")
	storageRoot := flag.String("storage-root", defaultStorageRoot(), "VM storage root used for capability and disk checks")
	qemuSystem := flag.String("qemu-system", "qemu-system-x86_64", "fixed QEMU system executable")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	healthHandler := health.NewHandler("vm-supervisor", version)
	mux := http.NewServeMux()
	mux.Handle("/healthz", healthHandler)
	mux.Handle("/readyz", healthHandler)
	mux.HandleFunc("GET /api/v1/host", func(w http.ResponseWriter, request *http.Request) {
		inspection := vmprovider.InspectHost(request.Context(), vmprovider.QemuConfig{
			SystemBinary: *qemuSystem,
			StorageRoot:  *storageRoot,
		})
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(inspection)
	})

	server := &http.Server{
		Addr:              *addr,
		Handler:           mux,
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
