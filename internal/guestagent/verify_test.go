package guestagent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newVerifyServer(t *testing.T, roots []string) *Server {
	t.Helper()
	return NewServerWithOptions(ServerOptions{
		Token:       "verify-token",
		Desktop:     &fakeDesktop{},
		VerifyRoots: roots,
	})
}

func postVerify(t *testing.T, server *Server, body VerifyRequest) (*http.Response, VerifyResult) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal verify body: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/verify", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer verify-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	response := recorder.Result()
	defer response.Body.Close()
	var result VerifyResult
	raw, _ := io.ReadAll(response.Body)
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("decode verify result %q: %v", string(raw), err)
	}
	return response, result
}

func TestVerifyFileEvidence(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "artifact.txt")
	if err := os.WriteFile(file, []byte("hello completion"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("hello completion"))
	expected := hex.EncodeToString(sum[:])
	size := int64(len("hello completion"))

	server := newVerifyServer(t, []string{root})
	_, result := postVerify(t, server, VerifyRequest{
		Checks: []VerifyCheck{{
			Type:      "file",
			Path:      file,
			SHA256:    expected,
			SizeBytes: &size,
		}},
	})
	if !result.OK {
		t.Fatalf("expected file evidence to verify, got %+v", result)
	}
	check := result.Checks[0]
	if check.SHA256 != expected || check.SizeBytes != size || !check.OK {
		t.Fatalf("unexpected check result: %+v", check)
	}

	_, mismatch := postVerify(t, server, VerifyRequest{
		Checks: []VerifyCheck{{
			Type:   "file",
			Path:   file,
			SHA256: "0" + expected[1:],
		}},
	})
	if mismatch.OK || mismatch.Checks[0].ErrorCode != "sha256_mismatch" {
		t.Fatalf("expected sha mismatch, got %+v", mismatch)
	}
}

func TestVerifyRejectsSymlinksAndEscapes(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is not available on this platform: %v", err)
	}
	server := newVerifyServer(t, []string{root})

	_, result := postVerify(t, server, VerifyRequest{
		Checks: []VerifyCheck{
			{Type: "file", Path: link},
			{Type: "file", Path: target},
		},
	})
	if result.OK {
		t.Fatalf("expected symlink and outside-root checks to fail: %+v", result)
	}
	if result.Checks[0].ErrorCode != "symlink_rejected" {
		t.Fatalf("expected symlink rejection, got %+v", result.Checks[0])
	}
	if result.Checks[1].ErrorCode != "path_outside_roots" {
		t.Fatalf("expected outside-root rejection, got %+v", result.Checks[1])
	}
}

func TestVerifyRequiresConfiguredRoots(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, result := postVerify(t, newVerifyServer(t, nil), VerifyRequest{
		Checks: []VerifyCheck{{Type: "file", Path: file}},
	})
	if result.OK || result.Checks[0].ErrorCode != "path_outside_roots" {
		t.Fatalf("expected fail-closed verification roots, got %+v", result)
	}
}

func TestVerifyRejectsUnknownChecks(t *testing.T) {
	_, result := postVerify(t, newVerifyServer(t, []string{t.TempDir()}), VerifyRequest{
		Checks: []VerifyCheck{{Type: "shell", Path: "/bin/sh"}},
	})
	if result.OK || result.Checks[0].ErrorCode != "unsupported_check" {
		t.Fatalf("expected unsupported check, got %+v", result)
	}
}
