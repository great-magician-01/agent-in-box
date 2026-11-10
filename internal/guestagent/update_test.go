package guestagent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

type updateErrorEnvelope struct {
	ActionID      string              `json:"actionId"`
	OK            bool                `json:"ok"`
	Error         errorEnvelopeError  `json:"error"`
	Compatibility UpdateCompatibility `json:"compatibility"`
}

type errorEnvelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return string(encoded)
}

func updateServer(t *testing.T, content []byte, status int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Errorf("update source must never receive the guest bearer token")
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte("upstream failure"))
			return
		}
		_, _ = w.Write(content)
	}))
	t.Cleanup(source.Close)
	return source, &hits
}

func TestUpdateStagesVerifiedBuild(t *testing.T) {
	content := []byte("verified guest-agent build bytes")
	source, hits := updateServer(t, content, http.StatusOK)
	updateDir := t.TempDir()
	server := NewServerWithOptions(ServerOptions{
		Token:          "secret-token",
		AgentVersion:   "0.1.0",
		Desktop:        &fakeDesktop{},
		UpdateDir:      updateDir,
		MaxUpdateBytes: 1 << 20,
	})
	manifest := UpdateManifest{
		ActionID:        "update-1",
		Version:         "0.2.0",
		URL:             source.URL + "/guest-agent",
		SizeBytes:       int64(len(content)),
		SHA256:          sha256Hex(content),
		ProtocolVersion: "0.2.0",
		OS:              runtime.GOOS,
		Architecture:    runtime.GOARCH,
	}
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("update status %d: %s", recorder.Code, recorder.Body)
	}
	result := decodeJSON[UpdateResult](t, recorder)
	if !result.OK || !result.RestartRequired || result.Activation != "external_service_manager" {
		t.Fatalf("unexpected update result: %+v", result)
	}
	if result.ActionID != "update-1" || result.Version != "0.2.0" || result.AlreadyStaged {
		t.Fatalf("unexpected update metadata: %+v", result)
	}
	if !result.Compatibility.Compatible || result.Compatibility.CurrentOS != runtime.GOOS {
		t.Fatalf("unexpected compatibility report: %+v", result.Compatibility)
	}
	staged, err := os.ReadFile(result.StagedPath)
	if err != nil {
		t.Fatalf("read staged update: %v", err)
	}
	if string(staged) != string(content) {
		t.Fatalf("staged update content mismatch")
	}
	if hits.Load() != 1 {
		t.Fatalf("expected one source request, got %d", hits.Load())
	}

	manifest.ActionID = "update-2"
	recorder = performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("second update status %d: %s", recorder.Code, recorder.Body)
	}
	result = decodeJSON[UpdateResult](t, recorder)
	if !result.AlreadyStaged || !result.OK {
		t.Fatalf("expected already-staged result: %+v", result)
	}
	if hits.Load() != 1 {
		t.Fatalf("already-staged update must not re-download: %d", hits.Load())
	}

	manifest.ActionID = "update-1"
	recorder = performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("duplicate update status %d: %s", recorder.Code, recorder.Body)
	}
	envelope := decodeJSON[updateErrorEnvelope](t, recorder)
	if envelope.Error.Code != "duplicate_action_id" || envelope.ActionID != "update-1" {
		t.Fatalf("unexpected duplicate update error: %s", recorder.Body)
	}
	if hits.Load() != 1 {
		t.Fatalf("duplicate update must not download: %d", hits.Load())
	}
}

func TestUpdateRejectsChecksumAndSizeMismatch(t *testing.T) {
	content := []byte("actual update payload")
	testCases := []struct {
		name   string
		size   int64
		sha    string
		code   string
		status int
	}{
		{name: "checksum", size: int64(len(content)), sha: sha256Hex([]byte("different")), code: "update_checksum_mismatch", status: http.StatusUnprocessableEntity},
		{name: "short body", size: int64(len(content) + 10), sha: sha256Hex(content), code: "update_size_mismatch", status: http.StatusUnprocessableEntity},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			source, _ := updateServer(t, content, http.StatusOK)
			updateDir := t.TempDir()
			server := NewServerWithOptions(ServerOptions{
				Token:          "secret-token",
				Desktop:        &fakeDesktop{},
				UpdateDir:      updateDir,
				MaxUpdateBytes: 1 << 20,
			})
			manifest := UpdateManifest{
				ActionID:  "update-" + strings.ReplaceAll(testCase.name, " ", "-"),
				Version:   "0.2.0",
				URL:       source.URL,
				SizeBytes: testCase.size,
				SHA256:    testCase.sha,
			}
			recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
			if recorder.Code != testCase.status {
				t.Fatalf("expected %d, got %d: %s", testCase.status, recorder.Code, recorder.Body)
			}
			envelope := decodeJSON[updateErrorEnvelope](t, recorder)
			if envelope.Error.Code != testCase.code {
				t.Fatalf("unexpected error code: %s", recorder.Body)
			}
			entries, err := os.ReadDir(updateDir)
			if err != nil {
				t.Fatalf("read update dir: %v", err)
			}
			if len(entries) != 0 {
				t.Fatalf("failed update left staged files behind: %v", entries)
			}
		})
	}
}

func TestUpdateRejectsInvalidManifests(t *testing.T) {
	content := []byte("payload")
	source, _ := updateServer(t, content, http.StatusOK)
	valid := UpdateManifest{
		ActionID:  "invalid-manifest",
		Version:   "0.2.0",
		URL:       source.URL,
		SizeBytes: int64(len(content)),
		SHA256:    sha256Hex(content),
	}

	testCases := []struct {
		name   string
		mutate func(*UpdateManifest)
		code   string
		status int
	}{
		{name: "version traversal", mutate: func(m *UpdateManifest) { m.Version = "../escape" }, code: "invalid_manifest", status: http.StatusBadRequest},
		{name: "short sha", mutate: func(m *UpdateManifest) { m.SHA256 = "abc" }, code: "invalid_manifest", status: http.StatusBadRequest},
		{name: "zero size", mutate: func(m *UpdateManifest) { m.SizeBytes = 0 }, code: "invalid_manifest", status: http.StatusBadRequest},
		{name: "invalid protocol", mutate: func(m *UpdateManifest) { m.ProtocolVersion = "not-semver" }, code: "invalid_manifest", status: http.StatusBadRequest},
		{name: "http remote", mutate: func(m *UpdateManifest) { m.URL = "http://example.com/agent" }, code: "source_forbidden", status: http.StatusBadRequest},
		{name: "unsupported scheme", mutate: func(m *UpdateManifest) { m.URL = "ftp://127.0.0.1/agent" }, code: "source_forbidden", status: http.StatusBadRequest},
		{name: "embedded credentials", mutate: func(m *UpdateManifest) { m.URL = "http://user:pass@127.0.0.1/agent" }, code: "source_forbidden", status: http.StatusBadRequest},
		{name: "relative url", mutate: func(m *UpdateManifest) { m.URL = "/agent" }, code: "source_forbidden", status: http.StatusBadRequest},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			manifest := valid
			testCase.mutate(&manifest)
			server := NewServerWithOptions(ServerOptions{
				Token:          "secret-token",
				Desktop:        &fakeDesktop{},
				UpdateDir:      t.TempDir(),
				MaxUpdateBytes: 1 << 20,
			})
			recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
			if recorder.Code != testCase.status {
				t.Fatalf("expected %d, got %d: %s", testCase.status, recorder.Code, recorder.Body)
			}
			envelope := decodeJSON[updateErrorEnvelope](t, recorder)
			if envelope.Error.Code != testCase.code || envelope.ActionID != "invalid-manifest" {
				t.Fatalf("unexpected validation error: %s", recorder.Body)
			}
		})
	}

	tooLarge := valid
	tooLarge.ActionID = "too-large"
	tooLarge.SizeBytes = 5
	server := NewServerWithOptions(ServerOptions{
		Token:          "secret-token",
		Desktop:        &fakeDesktop{},
		UpdateDir:      t.TempDir(),
		MaxUpdateBytes: 4,
	})
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, tooLarge), "secret-token", "")
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", recorder.Code, recorder.Body)
	}
	envelope := decodeJSON[updateErrorEnvelope](t, recorder)
	if envelope.Error.Code != "update_too_large" {
		t.Fatalf("unexpected oversize error: %s", recorder.Body)
	}
}

func TestUpdateReportsIncompatibleTargets(t *testing.T) {
	content := []byte("payload")
	testCases := []struct {
		name   string
		mutate func(*UpdateManifest)
	}{
		{name: "os", mutate: func(m *UpdateManifest) { m.OS = "plan9" }},
		{name: "architecture", mutate: func(m *UpdateManifest) { m.Architecture = "aib-unknown-arch" }},
		{name: "protocol major", mutate: func(m *UpdateManifest) { m.ProtocolVersion = "1.0.0" }},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			source, hits := updateServer(t, content, http.StatusOK)
			manifest := UpdateManifest{
				ActionID:  "incompatible-" + strings.ReplaceAll(testCase.name, " ", "-"),
				Version:   "0.2.0",
				URL:       source.URL,
				SizeBytes: int64(len(content)),
				SHA256:    sha256Hex(content),
			}
			testCase.mutate(&manifest)
			server := NewServerWithOptions(ServerOptions{
				Token:          "secret-token",
				Desktop:        &fakeDesktop{},
				UpdateDir:      t.TempDir(),
				MaxUpdateBytes: 1 << 20,
			})
			recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
			if recorder.Code != http.StatusConflict {
				t.Fatalf("expected 409, got %d: %s", recorder.Code, recorder.Body)
			}
			envelope := decodeJSON[updateErrorEnvelope](t, recorder)
			if envelope.Error.Code != "incompatible_update" || envelope.Compatibility.Compatible || len(envelope.Compatibility.Reasons) == 0 {
				t.Fatalf("unexpected incompatibility report: %s", recorder.Body)
			}
			if hits.Load() != 0 {
				t.Fatalf("incompatible update must not be downloaded: %d", hits.Load())
			}
		})
	}
}

func TestUpdateAllowsHTTPS(t *testing.T) {
	content := []byte("https update payload")
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	}))
	t.Cleanup(source.Close)
	server := NewServerWithOptions(ServerOptions{
		Token:            "secret-token",
		Desktop:          &fakeDesktop{},
		UpdateDir:        t.TempDir(),
		MaxUpdateBytes:   1 << 20,
		UpdateHTTPClient: source.Client(),
	})
	manifest := UpdateManifest{
		ActionID:  "https-update",
		Version:   "0.2.0",
		URL:       source.URL + "/guest-agent",
		SizeBytes: int64(len(content)),
		SHA256:    sha256Hex(content),
	}
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("HTTPS update status %d: %s", recorder.Code, recorder.Body)
	}
	result := decodeJSON[UpdateResult](t, recorder)
	if !result.OK || !result.RestartRequired {
		t.Fatalf("unexpected HTTPS update result: %+v", result)
	}
}

func TestUpdateRefusesUntrustedRedirects(t *testing.T) {
	content := []byte("payload")
	manifestSize := int64(len(content))

	t.Run("remote http redirect", func(t *testing.T) {
		source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "http://example.com/evil-agent", http.StatusFound)
		}))
		t.Cleanup(source.Close)
		updateDir := t.TempDir()
		server := NewServerWithOptions(ServerOptions{
			Token:          "secret-token",
			Desktop:        &fakeDesktop{},
			UpdateDir:      updateDir,
			MaxUpdateBytes: 1 << 20,
		})
		manifest := UpdateManifest{
			ActionID:  "redirect-remote",
			Version:   "0.2.0",
			URL:       source.URL,
			SizeBytes: manifestSize,
			SHA256:    sha256Hex(content),
		}
		recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
		if recorder.Code != http.StatusBadGateway {
			t.Fatalf("expected 502, got %d: %s", recorder.Code, recorder.Body)
		}
		envelope := decodeJSON[updateErrorEnvelope](t, recorder)
		if envelope.Error.Code != "update_fetch_failed" {
			t.Fatalf("unexpected redirect error: %s", recorder.Body)
		}
		entries, _ := os.ReadDir(updateDir)
		if len(entries) != 0 {
			t.Fatalf("redirect failure left files behind: %v", entries)
		}
	})

	t.Run("https to http downgrade", func(t *testing.T) {
		httpTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("downgraded redirect target must not be requested")
			_, _ = w.Write(content)
		}))
		t.Cleanup(httpTarget.Close)
		tlsSource := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, httpTarget.URL, http.StatusFound)
		}))
		t.Cleanup(tlsSource.Close)
		server := NewServerWithOptions(ServerOptions{
			Token:            "secret-token",
			Desktop:          &fakeDesktop{},
			UpdateDir:        t.TempDir(),
			MaxUpdateBytes:   1 << 20,
			UpdateHTTPClient: tlsSource.Client(),
		})
		manifest := UpdateManifest{
			ActionID:  "redirect-downgrade",
			Version:   "0.2.0",
			URL:       tlsSource.URL,
			SizeBytes: manifestSize,
			SHA256:    sha256Hex(content),
		}
		recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
		if recorder.Code != http.StatusBadGateway {
			t.Fatalf("expected 502, got %d: %s", recorder.Code, recorder.Body)
		}
	})
}

func TestUpdateRejectsTamperedStagedFile(t *testing.T) {
	content := []byte("original")
	updateDir := t.TempDir()
	sha := sha256Hex(content)
	tampered := []byte("tampered")
	target := filepath.Join(updateDir, "guest-agent-0.2.0-"+sha+".bin")
	if err := os.WriteFile(target, tampered, 0o600); err != nil {
		t.Fatalf("write tampered file: %v", err)
	}
	source, _ := updateServer(t, content, http.StatusOK)
	server := NewServerWithOptions(ServerOptions{
		Token:          "secret-token",
		Desktop:        &fakeDesktop{},
		UpdateDir:      updateDir,
		MaxUpdateBytes: 1 << 20,
	})
	manifest := UpdateManifest{
		ActionID:  "tampered",
		Version:   "0.2.0",
		URL:       source.URL,
		SizeBytes: int64(len(content)),
		SHA256:    sha,
	}
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", recorder.Code, recorder.Body)
	}
	envelope := decodeJSON[updateErrorEnvelope](t, recorder)
	if envelope.Error.Code != "staged_update_conflict" {
		t.Fatalf("unexpected tampered-file error: %s", recorder.Body)
	}
	unchanged, err := os.ReadFile(target)
	if err != nil || string(unchanged) != string(tampered) {
		t.Fatalf("tampered staged file was modified: %v %q", err, unchanged)
	}
}

func TestUpdateRequiresConfigurationAndAuthentication(t *testing.T) {
	content := []byte("payload")
	source, _ := updateServer(t, content, http.StatusOK)
	manifest := UpdateManifest{
		ActionID:  "update-auth",
		Version:   "0.2.0",
		URL:       source.URL,
		SizeBytes: int64(len(content)),
		SHA256:    sha256Hex(content),
	}
	body := mustJSON(t, manifest)

	unavailable := NewServerWithOptions(ServerOptions{Token: "secret-token", Desktop: &fakeDesktop{}})
	recorder := performRequest(t, unavailable.Handler(), http.MethodPost, "/v1/update", body, "secret-token", "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without an update directory, got %d: %s", recorder.Code, recorder.Body)
	}
	envelope := decodeJSON[updateErrorEnvelope](t, recorder)
	if envelope.Error.Code != "updates_unavailable" {
		t.Fatalf("unexpected unavailable error: %s", recorder.Body)
	}

	disabled := NewServerWithOptions(ServerOptions{Token: "secret-token", Desktop: &fakeDesktop{}, UpdateDir: t.TempDir()})
	recorder = performRequest(t, disabled.Handler(), http.MethodPost, "/v1/update", body, "", "update-auth")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", recorder.Code, recorder.Body)
	}
	authError := decodeJSON[errorEnvelope](t, recorder)
	if authError.ActionID != "update-auth" || authError.Error.Code != "unauthorized" {
		t.Fatalf("unauthenticated update should carry the action id: %s", recorder.Body)
	}
}

func TestUpdateReportsUpstreamFailure(t *testing.T) {
	content := []byte("payload")
	source, _ := updateServer(t, content, http.StatusInternalServerError)
	server := NewServerWithOptions(ServerOptions{
		Token:          "secret-token",
		Desktop:        &fakeDesktop{},
		UpdateDir:      t.TempDir(),
		MaxUpdateBytes: 1 << 20,
	})
	manifest := UpdateManifest{
		ActionID:  "upstream-failure",
		Version:   "0.2.0",
		URL:       source.URL,
		SizeBytes: int64(len(content)),
		SHA256:    sha256Hex(content),
	}
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/update", mustJSON(t, manifest), "secret-token", "")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d: %s", recorder.Code, recorder.Body)
	}
	envelope := decodeJSON[updateErrorEnvelope](t, recorder)
	if envelope.Error.Code != "update_fetch_failed" {
		t.Fatalf("unexpected upstream error: %s", recorder.Body)
	}
}

func TestParseUpdateURLPolicy(t *testing.T) {
	allowed := []string{
		"https://example.com/agent",
		"http://127.0.0.1:8080/agent",
		"http://localhost/agent",
		"http://[::1]:8080/agent",
	}
	for _, raw := range allowed {
		if _, err := parseUpdateURL(raw); err != nil {
			t.Fatalf("%s should be allowed: %v", raw, err)
		}
	}
	rejected := []string{
		"http://example.com/agent",
		"ftp://example.com/agent",
		"https://user:pass@example.com/agent",
		"/relative/agent",
		"http://127.0.0.1.evil.example/agent",
		"https://" + strings.Repeat("a", 3000),
	}
	for _, raw := range rejected {
		if _, err := parseUpdateURL(raw); err == nil {
			t.Fatalf("%s should be rejected", raw)
		}
	}
}
