package guestagent

import (
	"context"
	"image"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type errorEnvelope struct {
	ActionID string `json:"actionId"`
	OK       bool   `json:"ok"`
	Error    struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type blockingDesktop struct {
	delay time.Duration
	calls atomic.Int32
}

func (d *blockingDesktop) Info(context.Context) (DesktopInfo, error) {
	return DesktopInfo{DisplayServer: "x11", Width: 100, Height: 100}, nil
}

func (d *blockingDesktop) Screenshot(context.Context) (image.Image, error) {
	return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil
}

func (d *blockingDesktop) Input(ctx context.Context, request InputRequest) error {
	d.calls.Add(1)
	timer := time.NewTimer(d.delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (d *blockingDesktop) Close() error { return nil }

func TestInputAcceptsCallerActionIDAndRejectsDuplicates(t *testing.T) {
	desktop := &fakeDesktop{}
	server := NewServer("secret-token", desktop, nil)
	handler := server.Handler()

	body := `{"type":"type_text","text":"first","actionId":"action-1"}`
	recorder := performRequest(t, handler, http.MethodPost, "/v1/input", body, "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("first action status %d: %s", recorder.Code, recorder.Body)
	}
	result := decodeJSON[ActionResult](t, recorder)
	if !result.OK || result.ActionID != "action-1" {
		t.Fatalf("caller action id was not preserved: %+v", result)
	}
	if len(desktop.inputs) != 1 || desktop.inputs[0].ActionID != "action-1" {
		t.Fatalf("input was not forwarded with its action id: %+v", desktop.inputs)
	}

	recorder = performRequest(t, handler, http.MethodPost, "/v1/input", body, "secret-token", "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("duplicate action status %d: %s", recorder.Code, recorder.Body)
	}
	duplicate := decodeJSON[ActionResult](t, recorder)
	if duplicate.OK || duplicate.ActionID != "action-1" || duplicate.ErrorCode != "duplicate_action_id" {
		t.Fatalf("unexpected duplicate result: %+v", duplicate)
	}
	if len(desktop.inputs) != 1 {
		t.Fatalf("duplicate action must not execute twice: %d", len(desktop.inputs))
	}

	recorder = performRequest(t, handler, http.MethodPost, "/v1/input", `{"type":"type_text","text":"second"}`, "secret-token", "header-action")
	if recorder.Code != http.StatusOK {
		t.Fatalf("header action status %d: %s", recorder.Code, recorder.Body)
	}
	result = decodeJSON[ActionResult](t, recorder)
	if result.ActionID != "header-action" {
		t.Fatalf("header action id was not used: %+v", result)
	}

	recorder = performRequest(t, handler, http.MethodPost, "/v1/input", `{"type":"type_text","text":"third"}`, "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("generated action status %d: %s", recorder.Code, recorder.Body)
	}
	result = decodeJSON[ActionResult](t, recorder)
	if result.ActionID == "" {
		t.Fatalf("expected a generated action id: %+v", result)
	}
}

func TestInputRejectsInvalidActionIDs(t *testing.T) {
	desktop := &fakeDesktop{}
	handler := NewServer("secret-token", desktop, nil).Handler()

	testCases := []struct {
		name     string
		body     string
		headerID string
	}{
		{name: "too long", body: `{"type":"type_text","text":"x","actionId":"` + strings.Repeat("a", 129) + `"}`},
		{name: "invalid characters", body: `{"type":"type_text","text":"x","actionId":"bad id"}`},
		{name: "invalid header", headerID: "bad/id"},
		{name: "header body conflict", body: `{"type":"type_text","text":"x","actionId":"action-a"}`, headerID: "action-b"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := performRequest(t, handler, http.MethodPost, "/v1/input", testCase.body, "secret-token", testCase.headerID)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body)
			}
			envelope := decodeJSON[errorEnvelope](t, recorder)
			if envelope.Error.Code != "invalid_action_id" {
				t.Fatalf("unexpected error code: %s", recorder.Body)
			}
		})
	}
	if len(desktop.inputs) != 0 {
		t.Fatalf("invalid action ids must not execute input: %d", len(desktop.inputs))
	}
}

func TestUnauthenticatedInputCannotExecute(t *testing.T) {
	desktop := &fakeDesktop{}
	handler := NewServer("secret-token", desktop, nil).Handler()
	body := `{"type":"type_text","text":"must not run","actionId":"auth-action"}`

	for _, token := range []string{"", "wrong-token"} {
		recorder := performRequest(t, handler, http.MethodPost, "/v1/input", body, token, "auth-action")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: expected 401, got %d", token, recorder.Code)
		}
		envelope := decodeJSON[errorEnvelope](t, recorder)
		if envelope.Error.Code != "unauthorized" || envelope.ActionID != "auth-action" {
			t.Fatalf("unauthorized response should carry the action id: %s", recorder.Body)
		}
	}
	if len(desktop.inputs) != 0 {
		t.Fatalf("unauthenticated input executed: %+v", desktop.inputs)
	}
}

func TestInputValidationErrorsCarryActionID(t *testing.T) {
	handler := NewServer("secret-token", &fakeDesktop{}, nil).Handler()

	for _, body := range []string{
		`{"type":"click","shell":"whoami"}`,
		`{"type":`,
	} {
		recorder := performRequest(t, handler, http.MethodPost, "/v1/input", body, "secret-token", "validation-action")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body)
		}
		envelope := decodeJSON[errorEnvelope](t, recorder)
		if envelope.ActionID != "validation-action" {
			t.Fatalf("validation error should carry the action id: %s", recorder.Body)
		}
	}
}

func TestInputActionTimeoutIsBoundedByServer(t *testing.T) {
	desktop := &blockingDesktop{delay: 2 * time.Second}
	server := NewServerWithOptions(ServerOptions{
		Token:         "secret-token",
		Desktop:       desktop,
		ActionTimeout: 40 * time.Millisecond,
	})
	handler := server.Handler()

	started := time.Now()
	body := `{"type":"wait","milliseconds":2000,"timeoutMs":5000,"actionId":"slow-action"}`
	recorder := performRequest(t, handler, http.MethodPost, "/v1/input", body, "secret-token", "")
	elapsed := time.Since(started)
	if recorder.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408, got %d: %s", recorder.Code, recorder.Body)
	}
	if elapsed > time.Second {
		t.Fatalf("server timeout was not enforced, elapsed %s", elapsed)
	}
	result := decodeJSON[ActionResult](t, recorder)
	if result.OK || result.ActionID != "slow-action" || result.ErrorCode != "action_timeout" {
		t.Fatalf("unexpected timeout result: %+v", result)
	}
	if desktop.calls.Load() != 1 {
		t.Fatalf("expected one input call, got %d", desktop.calls.Load())
	}
}

func TestInputHonorsShorterCallerTimeout(t *testing.T) {
	desktop := &blockingDesktop{delay: 2 * time.Second}
	server := NewServerWithOptions(ServerOptions{
		Token:         "secret-token",
		Desktop:       desktop,
		ActionTimeout: 10 * time.Second,
	})
	started := time.Now()
	body := `{"type":"wait","milliseconds":2000,"timeoutMs":15,"actionId":"caller-timeout"}`
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/input", body, "secret-token", "")
	elapsed := time.Since(started)
	if recorder.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408, got %d: %s", recorder.Code, recorder.Body)
	}
	if elapsed > time.Second {
		t.Fatalf("caller timeout was not enforced, elapsed %s", elapsed)
	}
	result := decodeJSON[ActionResult](t, recorder)
	if result.ActionID != "caller-timeout" || result.ErrorCode != "action_timeout" {
		t.Fatalf("unexpected timeout result: %+v", result)
	}
}

func TestInputCompletesWithinTimeout(t *testing.T) {
	desktop := &blockingDesktop{delay: 5 * time.Millisecond}
	server := NewServerWithOptions(ServerOptions{
		Token:         "secret-token",
		Desktop:       desktop,
		ActionTimeout: time.Second,
	})
	body := `{"type":"wait","milliseconds":5,"timeoutMs":500,"actionId":"fast-action"}`
	recorder := performRequest(t, server.Handler(), http.MethodPost, "/v1/input", body, "secret-token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	result := decodeJSON[ActionResult](t, recorder)
	if !result.OK || result.ActionID != "fast-action" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestServerActionTimeoutCannotExceedHardMaximum(t *testing.T) {
	server := NewServerWithOptions(ServerOptions{
		Token:         "secret-token",
		Desktop:       &fakeDesktop{},
		ActionTimeout: time.Hour,
	})
	if server.actionTimeout != hardMaxActionTimeout {
		t.Fatalf("server accepted an unbounded action timeout: %s", server.actionTimeout)
	}
}

func TestInvalidTimeoutValues(t *testing.T) {
	handler := NewServer("secret-token", &fakeDesktop{}, nil).Handler()
	for _, testCase := range []struct {
		body   string
		header string
	}{
		{body: `{"type":"wait","milliseconds":1,"timeoutMs":-1}`},
		{body: `{"type":"wait","milliseconds":1}`, header: "not-a-number"},
		{body: `{"type":"wait","milliseconds":1}`, header: "0"},
		{body: `{"type":"wait","milliseconds":1,"timeoutMs":100}`, header: "200"},
	} {
		request := httptest.NewRequest(http.MethodPost, "/v1/input", strings.NewReader(testCase.body))
		request.Header.Set("Authorization", "Bearer secret-token")
		request.Header.Set(ActionIDHeader, "timeout-action")
		if testCase.header != "" {
			request.Header.Set(TimeoutHeader, testCase.header)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %q/%q, got %d: %s", testCase.body, testCase.header, recorder.Code, recorder.Body)
		}
		envelope := decodeJSON[errorEnvelope](t, recorder)
		if envelope.Error.Code != "invalid_timeout" || envelope.ActionID != "timeout-action" {
			t.Fatalf("unexpected timeout validation error: %s", recorder.Body)
		}
	}
}
