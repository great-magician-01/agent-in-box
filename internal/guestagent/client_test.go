package guestagent

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
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
		_ = json.NewEncoder(w).Encode(ActionResult{ActionID: "action-1", OK: true})
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
