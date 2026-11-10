package imagedownload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testImage(size int) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte((i*131 + 17) % 251)
	}
	return data
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func manifestFor(serverURL, fileName string, data []byte) Manifest {
	return Manifest{
		URL:      serverURL + "/image",
		FileName: fileName,
		Size:     int64(len(data)),
		SHA256:   sha256Hex(data),
	}
}

func writeImage(t *testing.T, w http.ResponseWriter, data []byte) {
	t.Helper()
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if _, err := w.Write(data); err != nil {
		t.Errorf("write response: %v", err)
	}
}

func parseRangeStart(header string) (int64, error) {
	const prefix = "bytes="
	if !strings.HasPrefix(header, prefix) || !strings.HasSuffix(header, "-") {
		return 0, fmt.Errorf("unexpected Range header %q", header)
	}
	value := strings.TrimSuffix(strings.TrimPrefix(header, prefix), "-")
	start, err := strconv.ParseInt(value, 10, 64)
	if err != nil || start < 0 {
		return 0, fmt.Errorf("invalid Range header %q", header)
	}
	return start, nil
}

func mustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected %s not to exist, stat error: %v", path, err)
	}
}

func mustHaveContent(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s content mismatch: got %d bytes, want %d", path, len(got), len(want))
	}
}

func TestDownloadSuccessVerifyAndReuse(t *testing.T) {
	data := testImage(512 << 10)
	var requests atomic.Int32
	var rangeRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Range") != "" {
			rangeRequests.Add(1)
		}
		if got := r.Header.Get("Accept-Encoding"); got != "identity" {
			t.Errorf("Accept-Encoding = %q, want identity", got)
		}
		writeImage(t, w, data)
	}))
	defer server.Close()

	storage := filepath.Join(t.TempDir(), "user-chosen", "images")
	downloader := New(storage)
	var progress []Progress
	downloader.Progress = func(p Progress) {
		progress = append(progress, p)
	}

	manifest := manifestFor(server.URL, "golden.img", data)
	result, err := downloader.Download(context.Background(), manifest)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if result.AlreadyPresent {
		t.Fatal("first download reported AlreadyPresent")
	}
	if result.Path != filepath.Join(storage, "golden.img") {
		t.Fatalf("unexpected final path %q", result.Path)
	}
	if result.Size != int64(len(data)) {
		t.Fatalf("size = %d, want %d", result.Size, len(data))
	}
	if result.SHA256 != manifest.SHA256 {
		t.Fatalf("SHA256 = %q, want %q", result.SHA256, manifest.SHA256)
	}
	if result.ResumedFrom != 0 || result.RangeIgnored {
		t.Fatalf("unexpected resume state: %+v", result)
	}
	mustHaveContent(t, result.Path, data)
	mustNotExist(t, result.Path+partialSuffix)

	if len(progress) < 2 {
		t.Fatalf("progress events = %d, want at least 2", len(progress))
	}
	first := progress[0]
	if first.DownloadedBytes != 0 || first.TotalBytes != int64(len(data)) {
		t.Fatalf("unexpected initial progress: %+v", first)
	}
	last := progress[len(progress)-1]
	if last.DownloadedBytes != int64(len(data)) || last.TotalBytes != int64(len(data)) {
		t.Fatalf("unexpected final progress: %+v", last)
	}

	// A second call must reuse the verified final file without networking.
	reused, err := downloader.Download(context.Background(), manifest)
	if err != nil {
		t.Fatalf("reuse: %v", err)
	}
	if !reused.AlreadyPresent {
		t.Fatal("second download did not report AlreadyPresent")
	}
	mustHaveContent(t, reused.Path, data)
	if got := requests.Load(); got != 1 {
		t.Fatalf("HTTP requests = %d, want 1", got)
	}
	if got := rangeRequests.Load(); got != 0 {
		t.Fatalf("unexpected ranged requests: %d", got)
	}
}

func TestResumeAfterInterruptedTransfer(t *testing.T) {
	data := testImage(1 << 20)
	const firstChunk = 384 << 10

	var requests atomic.Int32
	var rangeMu sync.Mutex
	var resumeRange string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 1 {
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			w.WriteHeader(http.StatusOK)
			if _, err := w.Write(data[:firstChunk]); err != nil {
				t.Errorf("write first chunk: %v", err)
				return
			}
			w.(http.Flusher).Flush()
			// Simulate the connection dying mid-transfer.
			panic(http.ErrAbortHandler)
		}

		rangeMu.Lock()
		resumeRange = r.Header.Get("Range")
		rangeMu.Unlock()
		start, err := parseRangeStart(r.Header.Get("Range"))
		if err != nil {
			t.Errorf("resume: %v", err)
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(data)-1, len(data)))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)-int(start)))
		w.WriteHeader(http.StatusPartialContent)
		if _, err := w.Write(data[start:]); err != nil {
			t.Errorf("write resumed body: %v", err)
		}
	}))
	defer server.Close()

	storage := t.TempDir()
	manifest := manifestFor(server.URL, "resume.img", data)
	partialPath := filepath.Join(storage, "resume.img"+partialSuffix)

	first := New(storage)
	if _, err := first.Download(context.Background(), manifest); err == nil {
		t.Fatal("expected the interrupted download to fail")
	}
	info, err := os.Stat(partialPath)
	if err != nil {
		t.Fatalf("partial file was not retained after interruption: %v", err)
	}
	if info.Size() <= 0 || info.Size() >= int64(len(data)) {
		t.Fatalf("partial size = %d, want between 1 and %d", info.Size(), len(data)-1)
	}
	partialSize := info.Size()
	mustNotExist(t, filepath.Join(storage, "resume.img"))

	// A new Downloader simulates application restart; it must resume from the
	// bytes already on disk.
	second := New(storage)
	result, err := second.Download(context.Background(), manifest)
	if err != nil {
		t.Fatalf("resumed download: %v", err)
	}
	if result.ResumedFrom != partialSize {
		t.Fatalf("ResumedFrom = %d, want %d", result.ResumedFrom, partialSize)
	}
	if result.RangeIgnored {
		t.Fatal("resume unexpectedly reported RangeIgnored")
	}
	mustHaveContent(t, result.Path, data)
	mustNotExist(t, partialPath)
	if got := requests.Load(); got != 2 {
		t.Fatalf("HTTP requests = %d, want 2", got)
	}
	rangeMu.Lock()
	defer rangeMu.Unlock()
	wantRange := fmt.Sprintf("bytes=%d-", partialSize)
	if resumeRange != wantRange {
		t.Fatalf("resume Range = %q, want %q", resumeRange, wantRange)
	}
}

func TestRangeIgnoredRestartsFromZero(t *testing.T) {
	data := testImage(256 << 10)
	storage := t.TempDir()
	partialPath := filepath.Join(storage, "ignored.img"+partialSuffix)
	// Leave a stale partial that must not be appended to.
	if err := os.WriteFile(partialPath, bytes.Repeat([]byte{0xee}, 4096), 0o644); err != nil {
		t.Fatalf("seed partial: %v", err)
	}

	var sawRange atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			sawRange.Store(true)
		}
		// Deliberately ignore Range and return the whole image with 200.
		writeImage(t, w, data)
	}))
	defer server.Close()

	downloader := New(storage)
	result, err := downloader.Download(context.Background(), manifestFor(server.URL, "ignored.img", data))
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if !result.RangeIgnored {
		t.Fatal("RangeIgnored = false, want true")
	}
	if result.ResumedFrom != 0 {
		t.Fatalf("ResumedFrom = %d, want 0 after full restart", result.ResumedFrom)
	}
	if !sawRange.Load() {
		t.Fatal("downloader did not ask the server for a range")
	}
	mustHaveContent(t, result.Path, data)
	mustNotExist(t, partialPath)
}

func TestWrongContentRangeDoesNotCorruptPartial(t *testing.T) {
	data := testImage(128 << 10)
	storage := t.TempDir()
	partialPath := filepath.Join(storage, "wrong-range.img"+partialSuffix)
	// Seed a plausible prefix. The server will claim 206 but start at zero,
	// so appending its body at offset 4096 would silently corrupt the image.
	if err := os.WriteFile(partialPath, data[:4096], 0o644); err != nil {
		t.Fatalf("seed partial: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=4096-" {
			t.Errorf("Range = %q, want bytes=4096-", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(data)-1, len(data)))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusPartialContent)
		if _, err := w.Write(data); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()

	_, err := New(storage).Download(context.Background(), manifestFor(server.URL, "wrong-range.img", data))
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v, want ErrInvalidResponse", err)
	}
	mustNotExist(t, filepath.Join(storage, "wrong-range.img"))
	// The partial cannot be trusted after a mismatched range response.
	mustNotExist(t, partialPath)
}

func TestChecksumMismatchLeavesNoFinalFile(t *testing.T) {
	data := testImage(128 << 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeImage(t, w, data)
	}))
	defer server.Close()

	storage := t.TempDir()
	manifest := manifestFor(server.URL, "corrupt.img", data)
	manifest.SHA256 = sha256Hex([]byte("different image"))

	downloader := New(storage)
	result, err := downloader.Download(context.Background(), manifest)
	if !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("error = %v, want ErrChecksumMismatch", err)
	}
	if result.Path != "" {
		t.Fatalf("unexpected result on failure: %+v", result)
	}
	mustNotExist(t, filepath.Join(storage, "corrupt.img"))
	// A corrupt partial would poison every future resume, so it must be gone.
	mustNotExist(t, filepath.Join(storage, "corrupt.img"+partialSuffix))
}

func TestContextCancellationKeepsResumablePartial(t *testing.T) {
	data := testImage(2 << 20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		const chunk = 64 << 10
		for offset := 0; offset < len(data); offset += chunk {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			end := offset + chunk
			if end > len(data) {
				end = len(data)
			}
			if _, err := w.Write(data[offset:end]); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			time.Sleep(time.Millisecond)
		}
	}))
	defer server.Close()

	storage := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	downloader := New(storage)
	downloader.Progress = func(p Progress) {
		if p.DownloadedBytes > 0 {
			cancel()
		}
	}

	_, err := downloader.Download(ctx, manifestFor(server.URL, "cancel.img", data))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	mustNotExist(t, filepath.Join(storage, "cancel.img"))
	partialPath := filepath.Join(storage, "cancel.img"+partialSuffix)
	info, statErr := os.Stat(partialPath)
	if statErr != nil {
		t.Fatalf("partial should be retained for resume: %v", statErr)
	}
	if info.Size() <= 0 {
		t.Fatalf("partial size = %d, want > 0", info.Size())
	}
}

func TestConcurrentSameTargetDownloadsOnce(t *testing.T) {
	data := testImage(1 << 20)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		time.Sleep(30 * time.Millisecond) // keep all callers overlapping
		writeImage(t, w, data)
	}))
	defer server.Close()

	storage := t.TempDir()
	downloader := New(storage)
	manifest := manifestFor(server.URL, "shared.img", data)

	const workers = 5
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]Result, workers)
	errs := make([]error, workers)
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = downloader.Download(context.Background(), manifest)
		}(i)
	}
	close(start)
	wg.Wait()

	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Errorf("worker %d: %v", i, errs[i])
		}
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("HTTP requests = %d, want 1 (same-target dedupe)", got)
	}
	alreadyPresent := 0
	for i := 0; i < workers; i++ {
		if results[i].Path != filepath.Join(storage, "shared.img") {
			t.Errorf("worker %d path = %q", i, results[i].Path)
		}
		if results[i].Size != int64(len(data)) || results[i].SHA256 != manifest.SHA256 {
			t.Errorf("worker %d result = %+v", i, results[i])
		}
		if results[i].AlreadyPresent {
			alreadyPresent++
		}
	}
	if alreadyPresent != workers-1 {
		t.Fatalf("AlreadyPresent count = %d, want %d", alreadyPresent, workers-1)
	}
	mustHaveContent(t, filepath.Join(storage, "shared.img"), data)
	mustNotExist(t, filepath.Join(storage, "shared.img"+partialSuffix))
}

func TestCompletePartialIsPromotedWithoutNetwork(t *testing.T) {
	data := testImage(64 << 10)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		writeImage(t, w, data)
	}))
	defer server.Close()

	storage := t.TempDir()
	partialPath := filepath.Join(storage, "complete.img"+partialSuffix)
	if err := os.WriteFile(partialPath, data, 0o644); err != nil {
		t.Fatalf("seed complete partial: %v", err)
	}

	downloader := New(storage)
	result, err := downloader.Download(context.Background(), manifestFor(server.URL, "complete.img", data))
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if result.ResumedFrom != int64(len(data)) {
		t.Fatalf("ResumedFrom = %d, want %d", result.ResumedFrom, len(data))
	}
	if result.AlreadyPresent {
		t.Fatal("a promoted partial should not be marked AlreadyPresent")
	}
	mustHaveContent(t, result.Path, data)
	mustNotExist(t, partialPath)
	if got := requests.Load(); got != 0 {
		t.Fatalf("HTTP requests = %d, want 0", got)
	}
}

func TestManifestValidation(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	data := testImage(32)
	base := manifestFor(server.URL, "valid.img", data)
	downloader := New(t.TempDir())

	cases := []struct {
		name     string
		manifest Manifest
	}{
		{name: "empty file name", manifest: func() Manifest { m := base; m.FileName = ""; return m }()},
		{name: "dot", manifest: func() Manifest { m := base; m.FileName = "."; return m }()},
		{name: "dotdot", manifest: func() Manifest { m := base; m.FileName = ".."; return m }()},
		{name: "parent escape", manifest: func() Manifest { m := base; m.FileName = "../escape.img"; return m }()},
		{name: "subdirectory", manifest: func() Manifest { m := base; m.FileName = "sub/dir.img"; return m }()},
		{name: "windows separator", manifest: func() Manifest { m := base; m.FileName = `sub\dir.img`; return m }()},
		{name: "windows drive", manifest: func() Manifest { m := base; m.FileName = "C:evil.img"; return m }()},
		{name: "nul byte", manifest: func() Manifest { m := base; m.FileName = "bad\x00name"; return m }()},
		{name: "trailing dot", manifest: func() Manifest { m := base; m.FileName = "name."; return m }()},
		{name: "surrounding space", manifest: func() Manifest { m := base; m.FileName = " name"; return m }()},
		{name: "empty url", manifest: func() Manifest { m := base; m.URL = ""; return m }()},
		{name: "non-http url", manifest: func() Manifest { m := base; m.URL = "file:///etc/passwd"; return m }()},
		{name: "missing sha", manifest: func() Manifest { m := base; m.SHA256 = ""; return m }()},
		{name: "short sha", manifest: func() Manifest { m := base; m.SHA256 = "abc123"; return m }()},
		{name: "non-hex sha", manifest: func() Manifest { m := base; m.SHA256 = strings.Repeat("z", 64); return m }()},
		{name: "negative size", manifest: func() Manifest { m := base; m.Size = -1; return m }()},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := downloader.Download(context.Background(), testCase.manifest)
			if !errors.Is(err, ErrInvalidManifest) {
				t.Fatalf("error = %v, want ErrInvalidManifest", err)
			}
		})
	}

	if got := requests.Load(); got != 0 {
		t.Fatalf("invalid manifests triggered %d HTTP requests", got)
	}

	downloader.MaxSize = 1024
	tooLarge := base
	tooLarge.Size = 2048
	if _, err := downloader.Download(context.Background(), tooLarge); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("oversized manifest error = %v, want ErrInvalidManifest", err)
	}
}

func TestMaxSizeEnforcedDuringStream(t *testing.T) {
	data := testImage(64 << 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Flush before the body to force chunked encoding, so the downloader
		// cannot rely on Content-Length to reject the image early.
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		if _, err := w.Write(data); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()

	storage := t.TempDir()
	downloader := New(storage)
	downloader.MaxSize = 16 << 10
	manifest := manifestFor(server.URL, "too-large.img", data)
	manifest.Size = 0 // unknown to the client

	_, err := downloader.Download(context.Background(), manifest)
	if !errors.Is(err, ErrSizeExceeded) {
		t.Fatalf("error = %v, want ErrSizeExceeded", err)
	}
	mustNotExist(t, filepath.Join(storage, "too-large.img"))
	mustNotExist(t, filepath.Join(storage, "too-large.img"+partialSuffix))
}

func TestDeclaredSizeMismatchRejectedBeforeWriting(t *testing.T) {
	data := testImage(32 << 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeImage(t, w, data)
	}))
	defer server.Close()

	storage := t.TempDir()
	manifest := manifestFor(server.URL, "wrong-size.img", data)
	manifest.Size = int64(len(data)) + 7

	_, err := New(storage).Download(context.Background(), manifest)
	if !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("error = %v, want ErrSizeMismatch", err)
	}
	mustNotExist(t, filepath.Join(storage, "wrong-size.img"))
	mustNotExist(t, filepath.Join(storage, "wrong-size.img"+partialSuffix))
}

func TestRedirectLimit(t *testing.T) {
	var hits atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, server.URL+r.URL.Path, http.StatusFound)
	}))
	defer server.Close()

	storage := t.TempDir()
	downloader := New(storage)
	downloader.MaxRedirects = 3
	manifest := manifestFor(server.URL, "redirect.img", testImage(16))

	_, err := downloader.Download(context.Background(), manifest)
	if !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("error = %v, want ErrTooManyRedirects", err)
	}
	if got := hits.Load(); got < 4 {
		t.Fatalf("redirect hits = %d, want at least 4", got)
	}
	mustNotExist(t, filepath.Join(storage, "redirect.img"))
	mustNotExist(t, filepath.Join(storage, "redirect.img"+partialSuffix))
}

func TestDeletePartialOnErrorPolicy(t *testing.T) {
	data := testImage(256 << 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(data[:64<<10]); err != nil {
			t.Errorf("write partial body: %v", err)
			return
		}
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	defer server.Close()

	storage := t.TempDir()
	downloader := New(storage)
	downloader.DeletePartialOnError = true

	_, err := downloader.Download(context.Background(), manifestFor(server.URL, "no-partial.img", data))
	if err == nil {
		t.Fatal("expected interrupted download to fail")
	}
	if errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("unexpected integrity error: %v", err)
	}
	mustNotExist(t, filepath.Join(storage, "no-partial.img"))
	mustNotExist(t, filepath.Join(storage, "no-partial.img"+partialSuffix))
}
