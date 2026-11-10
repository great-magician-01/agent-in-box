package guestagent

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestRPCServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/capabilities", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"unauthorized","message":"invalid token"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(Capabilities{
			ProtocolVersion: protocolVersion,
			DisplayServer:   "x11",
			Screenshot:      true,
			Input:           true,
			UnicodeInput:    true,
		})
	})
	mux.HandleFunc("POST /v1/input", func(w http.ResponseWriter, r *http.Request) {
		var input InputRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Errorf("decode input: %v", err)
		}
		if input.ActionID == "client-timeout" {
			w.WriteHeader(http.StatusRequestTimeout)
			_ = json.NewEncoder(w).Encode(ActionResult{
				ActionID:  "client-timeout",
				OK:        false,
				Error:     "action exceeded the server timeout",
				ErrorCode: "action_timeout",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(ActionResult{ActionID: "action-1", OK: true})
	})
	mux.HandleFunc("GET /v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Heartbeat{
			Status:           "ok",
			AgentVersion:     "1.2.3",
			ProtocolVersion:  protocolVersion,
			Compatible:       true,
			DesktopAvailable: true,
			DisplayServer:    "x11",
			UptimeSeconds:    42,
		})
	})
	mux.HandleFunc("GET /v1/version", func(w http.ResponseWriter, r *http.Request) {
		requested := r.URL.Query().Get("protocolVersion")
		compatible, compatibilityError := protocolCompatibility(requested)
		_ = json.NewEncoder(w).Encode(VersionInfo{
			AgentVersion:             "1.2.3",
			ProtocolVersion:          protocolVersion,
			MinimumProtocolVersion:   MinimumProtocolVersion,
			MaximumProtocolVersion:   MaximumProtocolVersion,
			RequestedProtocolVersion: requested,
			Compatible:               compatible,
			CompatibilityError:       compatibilityError,
		})
	})
	mux.HandleFunc("POST /v1/update", func(w http.ResponseWriter, r *http.Request) {
		var manifest UpdateManifest
		if err := json.NewDecoder(r.Body).Decode(&manifest); err != nil {
			t.Errorf("decode update: %v", err)
		}
		if manifest.Version == "incompatible" {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"actionId": manifest.ActionID,
				"ok":       false,
				"error":    map[string]string{"code": "incompatible_update", "message": "target OS mismatch"},
				"compatibility": UpdateCompatibility{
					Compatible: false,
					Reasons:    []string{"target OS mismatch"},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(UpdateResult{
			ActionID:        manifest.ActionID,
			OK:              true,
			Version:         manifest.Version,
			SizeBytes:       manifest.SizeBytes,
			SHA256:          manifest.SHA256,
			StagedPath:      "/updates/" + manifest.Version,
			RestartRequired: true,
			Activation:      "external_service_manager",
			Compatibility:   UpdateCompatibility{Compatible: true},
		})
	})
	mux.HandleFunc("GET /v1/screenshot", func(w http.ResponseWriter, r *http.Request) {
		capture := image.NewRGBA(image.Rect(0, 0, 8, 4))
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Agent-In-Box-Width", "8")
		w.Header().Set("X-Agent-In-Box-Height", "4")
		w.Header().Set("X-Agent-In-Box-Action-Id", "shot-1")
		_ = png.Encode(w, capture)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func TestGuestClient(t *testing.T) {
	server := newTestRPCServer(t)
	client := NewClient(server.URL, "test-token")
	ctx := context.Background()

	capabilities, err := client.Capabilities(ctx)
	if err != nil {
		t.Fatalf("capabilities: %v", err)
	}
	if !capabilities.Screenshot || !capabilities.UnicodeInput || capabilities.DisplayServer != "x11" {
		t.Fatalf("unexpected capabilities: %+v", capabilities)
	}

	result, err := client.Input(ctx, InputRequest{Type: "type_text", Text: "你好"})
	if err != nil {
		t.Fatalf("input: %v", err)
	}
	if !result.OK || result.ActionID != "action-1" {
		t.Fatalf("unexpected input result: %+v", result)
	}

	capture, metadata, err := client.Screenshot(ctx)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if capture.Bounds().Dx() != 8 || metadata.Width != 8 || metadata.Height != 4 || metadata.ActionID != "shot-1" {
		t.Fatalf("unexpected screenshot metadata: %+v bounds=%v", metadata, capture.Bounds())
	}
}

func TestGuestClientUnauthorized(t *testing.T) {
	server := newTestRPCServer(t)
	client := NewClient(server.URL, "wrong")
	_, err := client.Capabilities(context.Background())
	if err == nil {
		t.Fatal("expected unauthorized error")
	}
	rpcError, ok := err.(*RPCError)
	if !ok || rpcError.StatusCode != http.StatusUnauthorized || rpcError.Code != "unauthorized" {
		t.Fatalf("unexpected error: %T %+v", err, err)
	}
}

func TestGuestClientHeartbeatAndVersion(t *testing.T) {
	server := newTestRPCServer(t)
	client := NewClient(server.URL, "test-token")
	ctx := context.Background()

	heartbeat, err := client.Heartbeat(ctx)
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if heartbeat.AgentVersion != "1.2.3" || heartbeat.ProtocolVersion != protocolVersion ||
		!heartbeat.DesktopAvailable || heartbeat.UptimeSeconds != 42 {
		t.Fatalf("unexpected heartbeat: %+v", heartbeat)
	}

	version, err := client.VersionHandshake(ctx, "0.1.0")
	if err != nil {
		t.Fatalf("version handshake: %v", err)
	}
	if !version.Compatible || version.RequestedProtocolVersion != "0.1.0" || version.AgentVersion != "1.2.3" {
		t.Fatalf("unexpected version handshake: %+v", version)
	}

	version, err = client.VersionHandshake(ctx, "2.0.0")
	if err != nil {
		t.Fatalf("version handshake: %v", err)
	}
	if version.Compatible || version.CompatibilityError == "" {
		t.Fatalf("expected incompatible version handshake: %+v", version)
	}
}

func TestGuestClientUpdateResultAndError(t *testing.T) {
	server := newTestRPCServer(t)
	client := NewClient(server.URL, "test-token")
	ctx := context.Background()

	manifest := UpdateManifest{
		ActionID:  "update-client-1",
		Version:   "0.2.0",
		URL:       "https://example.com/agent",
		SizeBytes: 1234,
		SHA256:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	result, err := client.Update(ctx, manifest)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !result.OK || !result.RestartRequired || result.Activation != "external_service_manager" ||
		result.ActionID != "update-client-1" {
		t.Fatalf("unexpected update result: %+v", result)
	}

	manifest.Version = "incompatible"
	_, err = client.Update(ctx, manifest)
	if err == nil {
		t.Fatal("expected incompatible update error")
	}
	rpcError, ok := err.(*RPCError)
	if !ok || rpcError.StatusCode != http.StatusConflict || rpcError.Code != "incompatible_update" {
		t.Fatalf("unexpected update error: %T %+v", err, err)
	}
	if rpcError.ActionID != "update-client-1" || rpcError.Compatibility == nil || rpcError.Compatibility.Compatible {
		t.Fatalf("update error lost action id or compatibility: %+v", rpcError)
	}
}

func TestGuestClientPreservesActionIDOnActionError(t *testing.T) {
	server := newTestRPCServer(t)
	client := NewClient(server.URL, "test-token")
	_, err := client.Input(context.Background(), InputRequest{Type: "wait", ActionID: "client-timeout"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	rpcError, ok := err.(*RPCError)
	if !ok {
		t.Fatalf("unexpected error type: %T", err)
	}
	if rpcError.StatusCode != http.StatusRequestTimeout || rpcError.Code != "action_timeout" ||
		rpcError.ActionID != "client-timeout" || !strings.Contains(rpcError.Message, "timeout") {
		t.Fatalf("unexpected action error: %+v", rpcError)
	}
}
