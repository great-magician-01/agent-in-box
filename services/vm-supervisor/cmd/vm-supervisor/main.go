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

	"agent-in-box/internal/vmprovider"
	"agent-in-box/internal/vmsupervisor"
)

const version = "0.1.0"

func main() {
	defaultStorageRoot, err := vmsupervisor.DefaultStorageRoot(vmsupervisor.StoragePathOptions{})
	if err != nil {
		_, _ = os.Stderr.WriteString("resolve vm storage root: " + err.Error() + "\n")
		os.Exit(1)
	}
	addr := flag.String("addr", "127.0.0.1:7610", "loopback address for the supervisor API")
	storageRoot := flag.String("storage-root", defaultStorageRoot, "VM storage root")
	qemuSystem := flag.String("qemu-system", "qemu-system-x86_64", "fixed QEMU system executable")
	qemuImg := flag.String("qemu-img", "qemu-img", "fixed qemu-img executable")
	accelerator := flag.String("accelerator", "", "QEMU accelerator (default: whpx on Windows, kvm elsewhere)")
	aclTokenFile := flag.String("acl-token-file", "", "ACL bearer token file (default: <data-root>/supervisor-acl.token)")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if err := vmsupervisor.ValidateListenAddress(*addr); err != nil {
		logger.Error("refusing non-loopback listen address", "addr", *addr, "error", err)
		os.Exit(1)
	}

	provider, err := vmprovider.NewQemuProvider(vmprovider.QemuConfig{
		SystemBinary: *qemuSystem,
		ImageBinary:  *qemuImg,
		StorageRoot:  *storageRoot,
		Accelerator:  *accelerator,
		Logger:       logger,
	})
	if err != nil {
		logger.Error("create qemu provider", "error", err)
		os.Exit(1)
	}

	token, err := vmsupervisor.ResolveACLToken(vmsupervisor.TokenOptions{
		File:        *aclTokenFile,
		StorageRoot: *storageRoot,
	})
	if err != nil {
		logger.Error("resolve supervisor acl token", "error", err)
		os.Exit(1)
	}

	supervisor, err := vmsupervisor.New(vmsupervisor.Config{
		StorageRoot: *storageRoot,
		Provider:    provider,
		Token:       token.Token,
		Logger:      logger,
		ServiceName: "vm-supervisor",
		Version:     version,
		QemuConfig: vmprovider.QemuConfig{
			SystemBinary: *qemuSystem,
			ImageBinary:  *qemuImg,
			StorageRoot:  *storageRoot,
			Accelerator:  *accelerator,
			Logger:       logger,
		},
	})
	if err != nil {
		logger.Error("create supervisor", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              *addr,
		Handler:           supervisor,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// Snapshot create/restore has a 5 minute provider budget. The server must
		// wait longer than that so it can return the real result instead of closing
		// the connection while qemu-img is still running.
		WriteTimeout:   330 * time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		// Never log token.Token itself; the path is safe operational context.
		logger.Info("vm-supervisor listening",
			"addr", *addr, "version", version,
			"storageRoot", *storageRoot, "aclTokenFile", token.Path)
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
