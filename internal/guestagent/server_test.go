package guestagent

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeDesktop struct {
	inputs []InputRequest
}

func (f *fakeDesktop) Info(ctx context.Context) (DesktopInfo, error) {
	return DesktopInfo{DisplayServer: "x11", Width: 1280, Height: 800}, nil
}

func (f *fakeDesktop) Screenshot(ctx context.Context) (image.Image, error) {
	capture := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for index := range capture.Pix {
		capture.Pix[index] = 0x7f
	}
	return capture, nil
}

func (f *fakeDesktop) Input(ctx context.Context, request InputRequest) error {
	f.inputs = append(f.inputs, request)
	return nil
}

func (f *fakeDesktop) Close() error { return nil }

func TestGuestAgentRequiresAuthentication(t *testing.T) {
	server := NewServer("secret-token", &fakeDesktop{}, nil)
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong token, got %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	if !strings.Contains(recorder.Body.String(), `"unicodeInput":true`) {
		t.Fatalf("capabilities should advertise X11 Unicode input: %s", recorder.Body)
	}
}

func TestGuestAgentRestrictsClientCIDRs(t *testing.T) {
	server := NewServerWithOptions(ServerOptions{
		Token:              "secret-token",
		Desktop:            &fakeDesktop{},
		AllowedClientCIDRs: []string{"10.0.2.2/32"},
	})
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	request.RemoteAddr = "127.0.0.1:41000"
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("guest-local client should be forbidden, got %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	request.RemoteAddr = "10.0.2.2:41000"
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("forwarded host client should be allowed, got %d: %s", recorder.Code, recorder.Body)
	}
}

func TestGuestAgentRejectsMissingTokenConfiguration(t *testing.T) {
	server := NewServer("", &fakeDesktop{}, nil)
	request := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when token is not configured, got %d", recorder.Code)
	}
}

func TestGuestAgentScreenshotAndInput(t *testing.T) {
	desktop := &fakeDesktop{}
	server := NewServer("secret-token", desktop, nil)
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/v1/screenshot", nil)
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("screenshot status %d: %s", recorder.Code, recorder.Body)
	}
	if recorder.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("content type: %s", recorder.Header().Get("Content-Type"))
	}
	if recorder.Header().Get("X-Agent-In-Box-Width") != "4" {
		t.Fatalf("width header: %s", recorder.Header().Get("X-Agent-In-Box-Width"))
	}
	if _, err := png.Decode(bytes.NewReader(recorder.Body.Bytes())); err != nil {
		t.Fatalf("response is not PNG: %v", err)
	}

	body := `{"type":"type_text","text":"你好 Agent-in-Box"}`
	request = httptest.NewRequest(http.MethodPost, "/v1/input", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("input status %d: %s", recorder.Code, recorder.Body)
	}
	if len(desktop.inputs) != 1 || desktop.inputs[0].Text != "你好 Agent-in-Box" {
		t.Fatalf("input not forwarded: %+v", desktop.inputs)
	}
	if !strings.Contains(recorder.Body.String(), `"actionId"`) {
		t.Fatalf("input response lacks action id: %s", recorder.Body)
	}
}

func TestGuestAgentRejectsUnknownInputFields(t *testing.T) {
	server := NewServer("secret-token", &fakeDesktop{}, nil)
	request := httptest.NewRequest(http.MethodPost, "/v1/input", strings.NewReader(`{"type":"click","shell":"whoami"}`))
	request.Header.Set("Authorization", "Bearer secret-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown field, got %d", recorder.Code)
	}
}
