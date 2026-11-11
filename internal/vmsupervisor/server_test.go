package vmsupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"agent-in-box/internal/vmprovider"
)

const testToken = "test-supervisor-token-0123456789abcdef"

type fakeProvider struct {
	mu sync.Mutex

	states       map[string]vmprovider.VmState
	stateErrors  map[string]error
	createErr    error
	startErr     error
	stopErr      error
	suspendErr   error
	resumeErr    error
	consoleErr   error
	consoleURL   string
	createdSpec  vmprovider.VmSpec
	stopModes    []string
	reconciled   []string
	stateLookups []string
	snapshotTags []string
	restoredTags []string
	deletedVmIDs []string
}

func newFakeProvider() *fakeProvider {
	return &fakeProvider{
		states:      map[string]vmprovider.VmState{},
		stateErrors: map[string]error{},
		consoleURL:  "vnc://127.0.0.1:5901",
	}
}

func (f *fakeProvider) CreateVm(_ context.Context, spec vmprovider.VmSpec) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return vmprovider.VmState{}, f.createErr
	}
	f.createdSpec = spec
	state := vmprovider.VmState{
		ID: spec.ID, PowerState: vmprovider.PowerStopped, QMPPort: spec.QMPPort,
		SSHHostPort: spec.SSHHostPort, GuestHealth: "unknown",
	}
	f.states[spec.ID] = state
	return state, nil
}

func (f *fakeProvider) StartVm(_ context.Context, vmID string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return vmprovider.VmState{}, f.startErr
	}
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	state.PowerState = vmprovider.PowerRunning
	f.states[vmID] = state
	return state, nil
}

func (f *fakeProvider) StopVm(_ context.Context, vmID string, mode string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopErr != nil {
		return vmprovider.VmState{}, f.stopErr
	}
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	f.stopModes = append(f.stopModes, mode)
	state.PowerState = vmprovider.PowerStopped
	state.GuestHealth = "unknown"
	f.states[vmID] = state
	return state, nil
}

func (f *fakeProvider) SuspendVm(_ context.Context, vmID string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.suspendErr != nil {
		return vmprovider.VmState{}, f.suspendErr
	}
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	state.PowerState = vmprovider.PowerSuspended
	f.states[vmID] = state
	return state, nil
}

func (f *fakeProvider) ResumeVm(_ context.Context, vmID string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resumeErr != nil {
		return vmprovider.VmState{}, f.resumeErr
	}
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	state.PowerState = vmprovider.PowerRunning
	f.states[vmID] = state
	return state, nil
}

func (f *fakeProvider) GetVmState(_ context.Context, vmID string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stateLookups = append(f.stateLookups, vmID)
	if err := f.stateErrors[vmID]; err != nil {
		return vmprovider.VmState{}, err
	}
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	f.reconciled = append(f.reconciled, vmID)
	return state, nil
}

func (f *fakeProvider) CreateSnapshot(_ context.Context, vmID string, tag string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	f.snapshotTags = append(f.snapshotTags, tag)
	return state, nil
}

func (f *fakeProvider) RestoreSnapshot(_ context.Context, vmID string, tag string) (vmprovider.VmState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state, ok := f.states[vmID]
	if !ok {
		return vmprovider.VmState{}, vmprovider.ErrNotFound
	}
	f.restoredTags = append(f.restoredTags, tag)
	return state, nil
}

func (f *fakeProvider) AttachConsole(_ context.Context, vmID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.consoleErr != nil {
		return "", f.consoleErr
	}
	if _, ok := f.states[vmID]; !ok {
		return "", vmprovider.ErrNotFound
	}
	return f.consoleURL, nil
}

func (f *fakeProvider) DeleteVm(_ context.Context, vmID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.states[vmID]; !ok {
		return vmprovider.ErrNotFound
	}
	delete(f.states, vmID)
	f.deletedVmIDs = append(f.deletedVmIDs, vmID)
	return nil
}

func (f *fakeProvider) setState(state vmprovider.VmState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.states[state.ID] = state
}

func (f *fakeProvider) lastStopMode(t *testing.T) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.stopModes) == 0 {
		t.Fatal("stop was not called")
	}
	return f.stopModes[len(f.stopModes)-1]
}

func newTestServer(t *testing.T, provider vmprovider.Provider, storageRoot string, mutate func(*Config)) *Server {
	t.Helper()
	config := Config{
		StorageRoot: storageRoot,
		Provider:    provider,
		Token:       testToken,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServiceName: "vm-supervisor-test",
		Version:     "test",
		HostInspector: func(context.Context) vmprovider.HostInspection {
			return vmprovider.HostInspection{Platform: "test", Ready: true}
		},
	}
	if mutate != nil {
		mutate(&config)
	}
	server, err := New(config)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	return server
}

func request(t *testing.T, handler http.Handler, method, path, body string, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func decodeJSON(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response %q: %v", recorder.Body.String(), err)
	}
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) apiErrorResponse {
	t.Helper()
	var response apiErrorResponse
	decodeJSON(t, recorder, &response)
	if response.OK {
		t.Fatalf("expected ok=false: %s", recorder.Body.String())
	}
	return response
}

func TestACLBearerAuthentication(t *testing.T) {
	provider := newFakeProvider()
	server := newTestServer(t, provider, t.TempDir(), nil)

	if recorder := request(t, server, http.MethodGet, "/api/v1/vms", "", ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status: %d", recorder.Code)
	} else if response := decodeError(t, recorder); response.Error.Code != codeUnauthorized {
		t.Fatalf("missing token code: %+v", response)
	}

	if recorder := request(t, server, http.MethodGet, "/api/v1/vms", "", "wrong-token"); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status: %d", recorder.Code)
	}

	if recorder := request(t, server, http.MethodGet, "/api/v1/vms", "", testToken); recorder.Code != http.StatusOK {
		t.Fatalf("correct token status: %d body=%s", recorder.Code, recorder.Body.String())
	}

	if recorder := request(t, server, http.MethodGet, "/api/v1/host", "", ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("host must be protected: %d", recorder.Code)
	}
	recorder := request(t, server, http.MethodGet, "/api/v1/host", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("authenticated host status: %d", recorder.Code)
	}
	var inspection vmprovider.HostInspection
	decodeJSON(t, recorder, &inspection)
	if !inspection.Ready {
		t.Fatalf("unexpected host inspection: %+v", inspection)
	}

	if recorder := request(t, server, http.MethodGet, "/healthz", "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("healthz must stay public: %d", recorder.Code)
	}
	if recorder := request(t, server, http.MethodGet, "/readyz", "", ""); recorder.Code != http.StatusOK {
		t.Fatalf("readyz must stay public: %d", recorder.Code)
	}
}

func TestCreateAndLifecycleRoutes(t *testing.T) {
	provider := newFakeProvider()
	server := newTestServer(t, provider, t.TempDir(), nil)

	createBody := `{"id":"vm-1","name":"Test VM","baseImagePath":"/images/base.qcow2","seedImagePath":"/images/seed.iso","cpuCount":2,"memoryMb":2048,"diskSizeGb":20,"desktop":true,"qmpPort":14445,"sshHostPort":10023,"vncDisplay":1}`
	recorder := request(t, server, http.MethodPost, "/api/v1/vms", createBody, testToken)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"powerState":"stopped"`) {
		t.Fatalf("create response is not lowerCamel VmState: %s", recorder.Body.String())
	}
	provider.mu.Lock()
	created := provider.createdSpec
	provider.mu.Unlock()
	if created.ID != "vm-1" || created.CPUCount != 2 || created.MemoryMB != 2048 || !created.Desktop || created.VNCDisplay != 1 {
		t.Fatalf("unexpected created spec: %+v", created)
	}

	if recorder := request(t, server, http.MethodGet, "/api/v1/vms/vm-1", "", testToken); recorder.Code != http.StatusOK {
		t.Fatalf("get state status: %d", recorder.Code)
	}

	if recorder := request(t, server, http.MethodPost, "/api/v1/vms/vm-1/start", "", testToken); recorder.Code != http.StatusOK {
		t.Fatalf("start status: %d body=%s", recorder.Code, recorder.Body.String())
	} else {
		var state vmprovider.VmState
		decodeJSON(t, recorder, &state)
		if state.PowerState != vmprovider.PowerRunning {
			t.Fatalf("start state: %+v", state)
		}
	}

	if recorder := request(t, server, http.MethodPost, "/api/v1/vms/vm-1/stop", "", testToken); recorder.Code != http.StatusOK {
		t.Fatalf("default stop status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if mode := provider.lastStopMode(t); mode != "graceful" {
		t.Fatalf("default stop mode: %q", mode)
	}

	if recorder := request(t, server, http.MethodPost, "/api/v1/vms/vm-1/stop", `{"mode":"force"}`, testToken); recorder.Code != http.StatusOK {
		t.Fatalf("force stop status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if mode := provider.lastStopMode(t); mode != "force" {
		t.Fatalf("force stop mode: %q", mode)
	}

	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/suspend", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("suspend status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	var state vmprovider.VmState
	decodeJSON(t, recorder, &state)
	if state.PowerState != vmprovider.PowerSuspended {
		t.Fatalf("suspend state: %+v", state)
	}

	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/resume", `{}`, testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("resume status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	decodeJSON(t, recorder, &state)
	if state.PowerState != vmprovider.PowerRunning {
		t.Fatalf("resume state: %+v", state)
	}

	recorder = request(t, server, http.MethodGet, "/api/v1/vms/vm-1/console", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("console status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	var console struct {
		ConsoleURL string `json:"consoleUrl"`
	}
	decodeJSON(t, recorder, &console)
	if console.ConsoleURL != "vnc://127.0.0.1:5901" {
		t.Fatalf("console url: %q", console.ConsoleURL)
	}
}

func TestCreateValidation(t *testing.T) {
	provider := newFakeProvider()
	server := newTestServer(t, provider, t.TempDir(), nil)

	cases := []struct {
		name   string
		body   string
		status int
	}{
		{"empty body", "", http.StatusBadRequest},
		{"malformed json", `{"id":`, http.StatusBadRequest},
		{"unknown field", `{"id":"vm-1","unexpected":true}`, http.StatusBadRequest},
		{"wrong field type", `{"id":"vm-1","cpuCount":"two"}`, http.StatusBadRequest},
		{"trailing object", `{"id":"vm-1"} {"id":"vm-2"}`, http.StatusBadRequest},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := request(t, server, http.MethodPost, "/api/v1/vms", testCase.body, testToken)
			if recorder.Code != testCase.status {
				t.Fatalf("status: got %d want %d body=%s", recorder.Code, testCase.status, recorder.Body.String())
			}
			response := decodeError(t, recorder)
			if response.Error.Code != codeInvalidRequest {
				t.Fatalf("code: %+v", response)
			}
		})
	}

	limited := newTestServer(t, provider, t.TempDir(), func(config *Config) {
		config.MaxBodyBytes = 64
	})
	largeBody := `{"id":"vm-1","name":"` + strings.Repeat("x", 200) + `"}`
	recorder := request(t, limited, http.MethodPost, "/api/v1/vms", largeBody, testToken)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if response := decodeError(t, recorder); response.Error.Code != codeInvalidRequest {
		t.Fatalf("oversized body code: %+v", response)
	}

	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/start", `{"unexpected":true}`, testToken)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown action field status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/stop", `{"mode":"eventually"}`, testToken)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid stop mode status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if response := decodeError(t, recorder); response.Error.Code != codeInvalidSpec {
		t.Fatalf("invalid stop mode code: %+v", response)
	}
}

func TestErrorMapping(t *testing.T) {
	provider := newFakeProvider()
	server := newTestServer(t, provider, t.TempDir(), nil)

	if recorder := request(t, server, http.MethodGet, "/api/v1/vms/missing", "", testToken); recorder.Code != http.StatusNotFound {
		t.Fatalf("not found status: %d", recorder.Code)
	} else if response := decodeError(t, recorder); response.Error.Code != codeNotFound {
		t.Fatalf("not found code: %+v", response)
	}

	provider.createErr = vmprovider.ErrAlreadyExists
	if recorder := request(t, server, http.MethodPost, "/api/v1/vms", `{"id":"vm-1"}`, testToken); recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status: %d body=%s", recorder.Code, recorder.Body.String())
	} else if response := decodeError(t, recorder); response.Error.Code != codeConflict {
		t.Fatalf("conflict code: %+v", response)
	}
	provider.createErr = vmprovider.ErrInvalidSpec
	if recorder := request(t, server, http.MethodPost, "/api/v1/vms", `{"id":"vm-1"}`, testToken); recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid spec status: %d body=%s", recorder.Code, recorder.Body.String())
	} else if response := decodeError(t, recorder); response.Error.Code != codeInvalidSpec {
		t.Fatalf("invalid spec code: %+v", response)
	}
	provider.createErr = nil

	provider.setState(vmprovider.VmState{ID: "vm-1", PowerState: vmprovider.PowerStopped})
	provider.startErr = vmprovider.ErrQmpUnavailable
	if recorder := request(t, server, http.MethodPost, "/api/v1/vms/vm-1/start", "", testToken); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status: %d body=%s", recorder.Code, recorder.Body.String())
	} else if response := decodeError(t, recorder); response.Error.Code != codeUnavailable {
		t.Fatalf("unavailable code: %+v", response)
	}
	provider.startErr = nil

	provider.stateErrors["broken"] = errors.New("disk metadata exploded")
	if recorder := request(t, server, http.MethodGet, "/api/v1/vms/broken", "", testToken); recorder.Code != http.StatusInternalServerError {
		t.Fatalf("internal status: %d body=%s", recorder.Code, recorder.Body.String())
	} else {
		response := decodeError(t, recorder)
		if response.Error.Code != codeInternal || response.Error.Message != "internal error" {
			t.Fatalf("internal response leaked details: %+v", response)
		}
	}
}

func TestMethodAndRouteErrorsAreJSON(t *testing.T) {
	provider := newFakeProvider()
	server := newTestServer(t, provider, t.TempDir(), nil)

	recorderDelete := request(t, server, http.MethodDelete, "/api/v1/vms", "", testToken)
	if recorderDelete.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /api/v1/vms status: %d", recorderDelete.Code)
	}
	if response := decodeError(t, recorderDelete); response.Error.Code != codeMethodNotAllowed {
		t.Fatalf("DELETE /api/v1/vms code: %+v", response)
	}

	recorder := request(t, server, http.MethodGet, "/api/v1/unknown", "", testToken)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown route status: %d", recorder.Code)
	}
	if response := decodeError(t, recorder); response.Error.Code != codeNotFound {
		t.Fatalf("unknown route code: %+v", response)
	}
}

func TestSnapshotAndDeleteRoutes(t *testing.T) {
	provider := newFakeProvider()
	provider.setState(vmprovider.VmState{ID: "vm-1", PowerState: vmprovider.PowerStopped})
	server := newTestServer(t, provider, t.TempDir(), nil)

	recorder := request(t, server, http.MethodPost, "/api/v1/vms/vm-1/snapshots", `{"tag":"aib-test"}`, testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("create snapshot status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(provider.snapshotTags) != 1 || provider.snapshotTags[0] != "aib-test" {
		t.Fatalf("unexpected snapshot tags: %+v", provider.snapshotTags)
	}
	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/snapshots", `{}`, testToken)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing snapshot tag status: %d", recorder.Code)
	}

	recorder = request(t, server, http.MethodPost, "/api/v1/vms/vm-1/snapshots/restore", `{"tag":"aib-test"}`, testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("restore snapshot status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(provider.restoredTags) != 1 || provider.restoredTags[0] != "aib-test" {
		t.Fatalf("unexpected restored tags: %+v", provider.restoredTags)
	}

	recorder = request(t, server, http.MethodDelete, "/api/v1/vms/vm-1", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete vm status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(provider.deletedVmIDs) != 1 || provider.deletedVmIDs[0] != "vm-1" {
		t.Fatalf("unexpected deleted VMs: %+v", provider.deletedVmIDs)
	}
	recorder = request(t, server, http.MethodDelete, "/api/v1/vms/missing", "", testToken)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("delete missing vm status: %d", recorder.Code)
	}
}

func TestListVmsReconcilesAndSkipsBrokenEntries(t *testing.T) {
	root := t.TempDir()
	for _, vmID := range []string{"vm-1", "vm-2", "no-metadata", "broken"} {
		if err := os.MkdirAll(filepath.Join(root, vmID), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, vmID := range []string{"vm-1", "vm-2", "broken"} {
		if err := os.WriteFile(filepath.Join(root, vmID, "vm.json"), []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "not-a-directory.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	provider := newFakeProvider()
	provider.setState(vmprovider.VmState{ID: "vm-2", PowerState: vmprovider.PowerSuspended, GuestHealth: "healthy"})
	provider.setState(vmprovider.VmState{ID: "vm-1", PowerState: vmprovider.PowerRunning, GuestHealth: "healthy"})
	provider.stateErrors["broken"] = errors.New("corrupt vm.json")

	server := newTestServer(t, provider, root, nil)
	recorder := request(t, server, http.MethodGet, "/api/v1/vms", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Items []vmprovider.VmState `json:"items"`
	}
	decodeJSON(t, recorder, &response)
	if len(response.Items) != 2 {
		t.Fatalf("list items: %+v", response.Items)
	}
	if response.Items[0].ID != "vm-1" || response.Items[1].ID != "vm-2" {
		t.Fatalf("list order/content: %+v", response.Items)
	}

	provider.mu.Lock()
	lookups := append([]string(nil), provider.stateLookups...)
	provider.mu.Unlock()
	for _, id := range lookups {
		if id == "no-metadata" {
			t.Fatalf("provider was called for a directory without vm.json: %v", lookups)
		}
	}
}

func TestListMissingStorageRootIsEmpty(t *testing.T) {
	provider := newFakeProvider()
	root := filepath.Join(t.TempDir(), "does-not-exist")
	server := newTestServer(t, provider, root, nil)
	recorder := request(t, server, http.MethodGet, "/api/v1/vms", "", testToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Items []vmprovider.VmState `json:"items"`
	}
	decodeJSON(t, recorder, &response)
	if response.Items == nil || len(response.Items) != 0 {
		t.Fatalf("expected empty items array, got %#v", response)
	}
}
