package vmprovider

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeQMP struct {
	listener  net.Listener
	mu        sync.Mutex
	status    string
	stopCount int
	contCount int
}

func startFakeQMP(t *testing.T, initialStatus string) *fakeQMP {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.2:0")
	if err != nil {
		t.Fatalf("listen fake qmp: %v", err)
	}
	fake := &fakeQMP{listener: listener, status: initialStatus}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go fake.serve(conn)
		}
	}()
	return fake
}

func (f *fakeQMP) port(t *testing.T) int {
	t.Helper()
	_, portText, err := net.SplitHostPort(f.listener.Addr().String())
	if err != nil {
		t.Fatalf("split fake qmp address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse fake qmp port: %v", err)
	}
	return port
}

func (f *fakeQMP) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopCount, f.contCount
}

func (f *fakeQMP) serve(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	_, _ = writer.WriteString(`{"QMP":{"version":{"qemu":{"major":11,"minor":1,"micro":3}}}}` + "\n")
	_ = writer.Flush()
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var command struct {
			Execute string `json:"execute"`
		}
		if err := json.Unmarshal(line, &command); err != nil {
			return
		}
		switch command.Execute {
		case "qmp_capabilities":
			_, _ = writer.WriteString(`{"return":{}}` + "\n")
		case "query-status":
			f.mu.Lock()
			status := f.status
			f.mu.Unlock()
			_, _ = fmt.Fprintf(writer, "{\"return\":{\"status\":%q,\"running\":%t}}\n", status, status == "running")
		case "stop":
			f.mu.Lock()
			f.status = "suspended"
			f.stopCount++
			f.mu.Unlock()
			_, _ = writer.WriteString(`{"return":{}}` + "\n")
		case "cont":
			f.mu.Lock()
			f.status = "running"
			f.contCount++
			f.mu.Unlock()
			_, _ = writer.WriteString(`{"return":{}}` + "\n")
		default:
			_, _ = writer.WriteString(`{"error":{"class":"CommandNotFound","desc":"unexpected command"}}` + "\n")
		}
		if err := writer.Flush(); err != nil {
			return
		}
	}
}

func newSuspendTestProvider(t *testing.T, status string) (*QemuProvider, *fakeQMP) {
	t.Helper()
	fake := startFakeQMP(t, status)
	root := t.TempDir()
	provider, err := NewQemuProvider(QemuConfig{
		SystemBinary: "unused-qemu-system",
		ImageBinary:  "unused-qemu-img",
		StorageRoot:  root,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	dir := filepath.Join(root, "vm-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create vm dir: %v", err)
	}
	metadata := &vmMetadata{
		Spec: VmSpec{
			ID: "vm-1", BaseImagePath: "unused", CPUCount: 1, MemoryMB: 512,
			DiskSizeGB: 1, QMPPort: fake.port(t),
		},
		State: VmState{
			ID: "vm-1", PowerState: powerStateFromQMP(status), PID: os.Getpid(),
			QMPPort: fake.port(t), DiskPath: filepath.Join(dir, "disk.qcow2"),
			GuestHealth: "healthy",
		},
		CreatedAt: time.Now().UTC(),
	}
	if err := provider.save(metadata); err != nil {
		t.Fatalf("save metadata: %v", err)
	}
	return provider, fake
}

func TestSuspendResumeLifecycleAndIdempotency(t *testing.T) {
	provider, fake := newSuspendTestProvider(t, "running")
	ctx := context.Background()

	state, err := provider.SuspendVm(ctx, "vm-1")
	if err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if state.PowerState != PowerSuspended {
		t.Fatalf("suspend state: %+v", state)
	}
	if state.GuestHealth != "healthy" {
		t.Fatalf("suspend must not modify guest health: %+v", state)
	}
	stopCount, contCount := fake.counts()
	if stopCount != 1 || contCount != 0 {
		t.Fatalf("unexpected qmp command counts after suspend: stop=%d cont=%d", stopCount, contCount)
	}

	state, err = provider.SuspendVm(ctx, "vm-1")
	if err != nil {
		t.Fatalf("idempotent suspend: %v", err)
	}
	if state.PowerState != PowerSuspended || state.GuestHealth != "healthy" {
		t.Fatalf("idempotent suspend state: %+v", state)
	}
	stopCount, contCount = fake.counts()
	if stopCount != 1 || contCount != 0 {
		t.Fatalf("idempotent suspend repeated qmp stop: stop=%d cont=%d", stopCount, contCount)
	}

	state, err = provider.ResumeVm(ctx, "vm-1")
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if state.PowerState != PowerRunning || state.GuestHealth != "healthy" {
		t.Fatalf("resume state: %+v", state)
	}
	stopCount, contCount = fake.counts()
	if stopCount != 1 || contCount != 1 {
		t.Fatalf("unexpected qmp command counts after resume: stop=%d cont=%d", stopCount, contCount)
	}

	state, err = provider.ResumeVm(ctx, "vm-1")
	if err != nil {
		t.Fatalf("idempotent resume: %v", err)
	}
	if state.PowerState != PowerRunning {
		t.Fatalf("idempotent resume state: %+v", state)
	}
	stopCount, contCount = fake.counts()
	if stopCount != 1 || contCount != 1 {
		t.Fatalf("idempotent resume repeated qmp cont: stop=%d cont=%d", stopCount, contCount)
	}
}

func TestStartSuspendedVmDoesNotClaimItIsRunning(t *testing.T) {
	provider, fake := newSuspendTestProvider(t, "suspended")
	state, err := provider.StartVm(context.Background(), "vm-1")
	if err != nil {
		t.Fatalf("start reconciliation: %v", err)
	}
	if state.PowerState != PowerSuspended {
		t.Fatalf("start misreported suspended guest: %+v", state)
	}
	stopCount, contCount := fake.counts()
	if stopCount != 0 || contCount != 0 {
		t.Fatalf("start must not implicitly resume: stop=%d cont=%d", stopCount, contCount)
	}
}

func TestSuspendResumeOnlyOnMatchingQMPState(t *testing.T) {
	provider, fake := newSuspendTestProvider(t, "shutdown")
	ctx := context.Background()

	if _, err := provider.SuspendVm(ctx, "vm-1"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning for suspend from shutdown, got %v", err)
	}
	if _, err := provider.ResumeVm(ctx, "vm-1"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning for resume from shutdown, got %v", err)
	}
	stopCount, contCount := fake.counts()
	if stopCount != 0 || contCount != 0 {
		t.Fatalf("wrong-state transition sent qmp commands: stop=%d cont=%d", stopCount, contCount)
	}
}

func TestSuspendResumeStoppedVM(t *testing.T) {
	root := t.TempDir()
	provider, err := NewQemuProvider(QemuConfig{
		SystemBinary: "unused-qemu-system",
		ImageBinary:  "unused-qemu-img",
		StorageRoot:  root,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "vm-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	metadata := &vmMetadata{
		Spec:  VmSpec{ID: "vm-1", BaseImagePath: "unused", CPUCount: 1, MemoryMB: 512, DiskSizeGB: 1},
		State: VmState{ID: "vm-1", PowerState: PowerStopped, GuestHealth: "unknown"},
	}
	if err := provider.save(metadata); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.SuspendVm(context.Background(), "vm-1"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning, got %v", err)
	}
	if _, err := provider.ResumeVm(context.Background(), "vm-1"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning, got %v", err)
	}
	state, err := provider.GetVmState(context.Background(), "vm-1")
	if err != nil || state.PowerState != PowerStopped {
		t.Fatalf("state after rejected transitions: %+v %v", state, err)
	}
}

func TestSuspendQmpUnavailable(t *testing.T) {
	root := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.2:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	_ = listener.Close()

	provider, err := NewQemuProvider(QemuConfig{
		SystemBinary: "unused-qemu-system",
		ImageBinary:  "unused-qemu-img",
		StorageRoot:  root,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "vm-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := provider.save(&vmMetadata{
		Spec:  VmSpec{ID: "vm-1", BaseImagePath: "unused", CPUCount: 1, MemoryMB: 512, DiskSizeGB: 1, QMPPort: port},
		State: VmState{ID: "vm-1", PowerState: PowerRunning, PID: os.Getpid(), QMPPort: port, DiskPath: filepath.Join(dir, "disk.qcow2")},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.SuspendVm(context.Background(), "vm-1"); !errors.Is(err, ErrQmpUnavailable) {
		t.Fatalf("expected ErrQmpUnavailable, got %v", err)
	}
}

func TestKeyedMutexSerializesSameVMOnly(t *testing.T) {
	var locks keyedMutex
	unlockA := locks.Lock("a")

	acquiredA := make(chan struct{})
	go func() {
		unlock := locks.Lock("a")
		close(acquiredA)
		unlock()
	}()

	select {
	case <-acquiredA:
		t.Fatal("second lock for the same vm was not blocked")
	case <-time.After(50 * time.Millisecond):
	}

	acquiredB := make(chan struct{})
	go func() {
		unlock := locks.Lock("b")
		close(acquiredB)
		unlock()
	}()
	select {
	case <-acquiredB:
	case <-time.After(time.Second):
		t.Fatal("lock for a different vm was blocked")
	}

	unlockA()
	select {
	case <-acquiredA:
	case <-time.After(time.Second):
		t.Fatal("waiting lock was not released")
	}
}

func TestVmBoundaryJSONUsesLowerCamelAndReadsLegacyFields(t *testing.T) {
	var metadata vmMetadata
	legacy := `{"Spec":{"ID":"vm-1","BaseImagePath":"base.qcow2","CPUCount":2,"MemoryMB":2048,"DiskSizeGB":20},"State":{"ID":"vm-1","PowerState":"suspended","GuestHealth":"healthy","ConsoleURL":"vnc://127.0.0.1:5901"}}`
	if err := json.Unmarshal([]byte(legacy), &metadata); err != nil {
		t.Fatalf("decode legacy metadata: %v", err)
	}
	if metadata.Spec.ID != "vm-1" || metadata.Spec.CPUCount != 2 || metadata.State.PowerState != PowerSuspended {
		t.Fatalf("legacy metadata fields not read: %+v", metadata)
	}

	encoded, err := json.Marshal(metadata.State)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"id":"vm-1"`, `"powerState":"suspended"`, `"guestHealth":"healthy"`, `"consoleUrl":"vnc://127.0.0.1:5901"`} {
		if !strings.Contains(string(encoded), expected) {
			t.Fatalf("state JSON missing %s: %s", expected, encoded)
		}
	}
}
