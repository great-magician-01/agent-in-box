package health

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthHandler(t *testing.T) {
	handler := NewHandler("vm-supervisor", "0.1.0", "test-nonce")

	for _, path := range []string{"/healthz", "/readyz"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		recorder := httptest.NewRecorder()

		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: expected status 200, got %d", path, recorder.Code)
		}

		var response Response
		if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
			t.Fatalf("%s: decode response: %v", path, err)
		}
		if response.Status != "ok" {
			t.Fatalf("%s: expected ok status, got %q", path, response.Status)
		}
		if response.Service != "vm-supervisor" {
			t.Fatalf("%s: unexpected service %q", path, response.Service)
		}
		if response.Version != "0.1.0" {
			t.Fatalf("%s: unexpected version %q", path, response.Version)
		}
		if response.InstanceNonce != "test-nonce" {
			t.Fatalf("%s: unexpected instance nonce %q", path, response.InstanceNonce)
		}
	}
}

func TestUnknownPath(t *testing.T) {
	handler := NewHandler("vm-supervisor", "0.1.0", "")
	request := httptest.NewRequest(http.MethodGet, "/unknown", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", recorder.Code)
	}
}
