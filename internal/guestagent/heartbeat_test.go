package guestagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func performRequest(t *testing.T, handler http.Handler, method, path, body, token, actionID string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if actionID != "" {
		request.Header.Set(ActionIDHeader, actionID)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeJSON[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode response %q: %v", recorder.Body.String(), err)
	}
	return value
}

func TestHeartbeatAndVersionHandshake(t *testing.T) {
	started := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	current := started
	server := NewServerWithOptions(ServerOptions{
		Token:        "secret-token",
		AgentVersion: "1.2.3-build.7",
		Desktop:      &fakeDesktop{},
		Now:          func() time.Time { return current },
	})
	handler := server.Handler()

	unauthorized := performRequest(t, handler, http.MethodGet, "/v1/heartbeat", "", "", "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("heartbeat without auth: expected 401, got %d", unauthorized.Code)
	}

	current = started.Add(5 * time.Second)
	recorder := performRequest(t, handler, http.MethodGet, "/v1/heartbeat?protocolVersion=0.1.9", "", "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("heartbeat status %d: %s", recorder.Code, recorder.Body)
	}
	heartbeat := decodeJSON[Heartbeat](t, recorder)
	if heartbeat.Status != "ok" || !heartbeat.DesktopAvailable || heartbeat.DisplayServer != "x11" {
		t.Fatalf("unexpected heartbeat: %+v", heartbeat)
	}
	if heartbeat.AgentVersion != "1.2.3-build.7" || heartbeat.ProtocolVersion != protocolVersion {
		t.Fatalf("heartbeat version mismatch: %+v", heartbeat)
	}
	if !heartbeat.Compatible || heartbeat.RequestedProtocolVersion != "0.1.9" {
		t.Fatalf("compatible handshake expected: %+v", heartbeat)
	}
	if heartbeat.UptimeSeconds != 5 {
		t.Fatalf("expected 5 seconds of uptime, got %d", heartbeat.UptimeSeconds)
	}
	if heartbeat.Now != current.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected heartbeat timestamp: %s", heartbeat.Now)
	}

	recorder = performRequest(t, handler, http.MethodGet, "/v1/heartbeat?protocolVersion=1.0.0", "", "secret-token", "")
	heartbeat = decodeJSON[Heartbeat](t, recorder)
	if heartbeat.Compatible || heartbeat.CompatibilityError == "" {
		t.Fatalf("incompatible handshake should be reported: %+v", heartbeat)
	}

	recorder = performRequest(t, handler, http.MethodGet, "/v1/version", "", "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("version status %d: %s", recorder.Code, recorder.Body)
	}
	version := decodeJSON[VersionInfo](t, recorder)
	if version.AgentVersion != "1.2.3-build.7" || version.ProtocolVersion != protocolVersion {
		t.Fatalf("unexpected version handshake: %+v", version)
	}
	if !version.Compatible || version.MinimumProtocolVersion != MinimumProtocolVersion || version.MaximumProtocolVersion != MaximumProtocolVersion {
		t.Fatalf("unexpected version compatibility fields: %+v", version)
	}

	recorder = performRequest(t, handler, http.MethodGet, "/v1/version?protocolVersion=0.2.0", "", "secret-token", "")
	version = decodeJSON[VersionInfo](t, recorder)
	if version.Compatible || version.RequestedProtocolVersion != "0.2.0" {
		t.Fatalf("expected incompatible version handshake: %+v", version)
	}

	recorder = performRequest(t, handler, http.MethodGet, "/v1/capabilities", "", "secret-token", "")
	capabilities := decodeJSON[Capabilities](t, recorder)
	if capabilities.AgentVersion != "1.2.3-build.7" || capabilities.ProtocolVersion != protocolVersion {
		t.Fatalf("capabilities must expose the explicit build version: %+v", capabilities)
	}
}

func TestHeartbeatDegradesWithoutDesktop(t *testing.T) {
	server := NewServerWithOptions(ServerOptions{
		Token:        "secret-token",
		AgentVersion: "0.1.0-test",
	})
	recorder := performRequest(t, server.Handler(), http.MethodGet, "/v1/heartbeat", "", "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("heartbeat must stay available without a desktop: %d %s", recorder.Code, recorder.Body)
	}
	heartbeat := decodeJSON[Heartbeat](t, recorder)
	if heartbeat.Status != "degraded" || heartbeat.DesktopAvailable || heartbeat.DesktopError == "" {
		t.Fatalf("expected degraded heartbeat: %+v", heartbeat)
	}
	if heartbeat.AgentVersion != "0.1.0-test" {
		t.Fatalf("degraded heartbeat lost the build version: %+v", heartbeat)
	}
}

type failingInfoDesktop struct {
	fakeDesktop
}

func (d *failingInfoDesktop) Info(context.Context) (DesktopInfo, error) {
	return DesktopInfo{}, errors.New("X11 display disappeared")
}

func TestHeartbeatSurvivesDesktopInfoFailure(t *testing.T) {
	server := NewServerWithOptions(ServerOptions{
		Token:        "secret-token",
		AgentVersion: "0.1.0-test",
		Desktop:      &failingInfoDesktop{},
	})
	recorder := performRequest(t, server.Handler(), http.MethodGet, "/v1/heartbeat", "", "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("heartbeat should not fail with the desktop: %d %s", recorder.Code, recorder.Body)
	}
	heartbeat := decodeJSON[Heartbeat](t, recorder)
	if heartbeat.Status != "degraded" || !heartbeat.DesktopAvailable || heartbeat.DesktopError != "X11 display disappeared" {
		t.Fatalf("unexpected degraded heartbeat: %+v", heartbeat)
	}
	if heartbeat.AgentVersion != "0.1.0-test" || !heartbeat.Compatible {
		t.Fatalf("degraded heartbeat lost version information: %+v", heartbeat)
	}
}

func TestActionTrackerIsBoundedAndExpires(t *testing.T) {
	current := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	tracker := newActionTracker(func() time.Time { return current })
	tracker.limit = 2
	tracker.ttl = time.Minute

	if !tracker.reserve("first") {
		t.Fatal("first action id should be accepted")
	}
	if tracker.reserve("first") {
		t.Fatal("duplicate action id must be rejected")
	}
	if !tracker.reserve("second") || !tracker.reserve("third") {
		t.Fatal("new action ids should stay accepted")
	}
	if len(tracker.seen) != 2 {
		t.Fatalf("tracker exceeded its bound: %d", len(tracker.seen))
	}

	current = current.Add(2 * time.Minute)
	if !tracker.reserve("first") {
		t.Fatal("action ids should be reusable after the retention window")
	}
}
