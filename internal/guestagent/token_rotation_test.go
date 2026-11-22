package guestagent

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"agent-in-box/internal/securefile"
)

func TestGuestAgentTokenFileRotationAndRevocation(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "guest-agent.token")
	if err := securefile.InstallTokenAtomically(tokenFile, "token-one"); err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(ServerOptions{TokenFile: tokenFile, Desktop: &fakeDesktop{}})
	handler := server.Handler()

	request := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	if response := request("token-one"); response.Code != http.StatusOK {
		t.Fatalf("initial token returned %d", response.Code)
	}
	if err := securefile.InstallTokenAtomically(tokenFile, "token-two"); err != nil {
		t.Fatal(err)
	}
	if response := request("token-one"); response.Code != http.StatusUnauthorized {
		t.Fatalf("rotated token returned %d", response.Code)
	}
	if response := request("token-two"); response.Code != http.StatusOK {
		t.Fatalf("new token returned %d", response.Code)
	}
	if err := os.Remove(tokenFile); err != nil {
		t.Fatal(err)
	}
	if response := request("token-two"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("revoked token returned %d", response.Code)
	}
}
