package guestagent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newWorkspaceServer(t *testing.T, roots ...string) http.Handler {
	t.Helper()
	return NewServerWithOptions(ServerOptions{
		Token:          "secret-token",
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WorkspaceRoots: roots,
	}).Handler()
}

func TestWorkspaceArchiveAndRestore(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.MkdirAll(filepath.Join(workspace, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "notes.txt"), []byte("hello phase 9"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "nested", "data.bin"), []byte{1, 2, 3}, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := newWorkspaceServer(t, root)

	archive := performRequest(t, handler, http.MethodGet,
		"/v1/workspace/archive?path="+workspace, "", "secret-token", "")
	if archive.Code != http.StatusOK {
		t.Fatalf("archive status: %d body=%s", archive.Code, archive.Body.String())
	}
	body := archive.Body.Bytes()
	expectedSha := sha256.Sum256(body)
	if archive.Header().Get("X-Agent-In-Box-Sha256") != hex.EncodeToString(expectedSha[:]) {
		t.Fatalf("archive sha header mismatch: %s", archive.Header().Get("X-Agent-In-Box-Sha256"))
	}
	if archive.Header().Get("X-Agent-In-Box-Files") != "2" {
		t.Fatalf("file count: %s", archive.Header().Get("X-Agent-In-Box-Files"))
	}
	entries := readArchive(t, body)
	if string(entries["notes.txt"]) != "hello phase 9" {
		t.Fatalf("unexpected archive entries: %+v", entries)
	}
	if !bytes.Equal(entries["nested/data.bin"], []byte{1, 2, 3}) {
		t.Fatalf("nested archive entry mismatch: %+v", entries)
	}

	target := filepath.Join(root, "restored")
	request := httptest.NewRequest(http.MethodPost, "/v1/workspace/restore?path="+target, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret-token")
	request.Header.Set("Content-Type", "application/gzip")
	request.Header.Set("X-Agent-In-Box-Sha256", hex.EncodeToString(expectedSha[:]))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("restore status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	restored, err := os.ReadFile(filepath.Join(target, "notes.txt"))
	if err != nil || string(restored) != "hello phase 9" {
		t.Fatalf("restored file: %q err=%v", restored, err)
	}
}

func TestWorkspaceRejectsEscapesAndSymlinks(t *testing.T) {
	root := t.TempDir()
	handler := newWorkspaceServer(t, root)

	outside := filepath.Join(t.TempDir(), "outside")
	recorder := performRequest(t, handler, http.MethodGet,
		"/v1/workspace/archive?path="+outside, "", "secret-token", "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("outside workspace status: %d", recorder.Code)
	}

	unsafe := buildArchive(t, map[string]archiveEntry{
		"link": {typeflag: tar.TypeSymlink, linkname: "/etc/passwd"},
	})
	target := filepath.Join(root, "unsafe")
	request := httptest.NewRequest(http.MethodPost, "/v1/workspace/restore?path="+target, bytes.NewReader(unsafe))
	request.Header.Set("Authorization", "Bearer secret-token")
	request.Header.Set("Content-Type", "application/gzip")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("symlink archive status: %d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("unsafe restore should not create target: %v", err)
	}
}

type archiveEntry struct {
	content  []byte
	typeflag byte
	linkname string
}

func readArchive(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	gzipReader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	entries := map[string][]byte{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		entries[header.Name] = content
	}
	return entries
}

func buildArchive(t *testing.T, entries map[string]archiveEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(gzipWriter)
	for name, entry := range entries {
		header := &tar.Header{Name: name, Mode: 0o600, Size: int64(len(entry.content))}
		if entry.typeflag != 0 {
			header.Typeflag = entry.typeflag
		} else {
			header.Typeflag = tar.TypeReg
		}
		header.Linkname = entry.linkname
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if len(entry.content) > 0 {
			if _, err := writer.Write(entry.content); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
