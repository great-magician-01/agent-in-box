// Package imagedownload downloads VM images with resumable HTTP Range
// transfers, SHA-256 verification, and atomic activation.
//
// A download is written to "<target>.partial" in the configured storage
// directory. Only after the complete file matches the manifest size and
// SHA-256 is it renamed to the final target path. A corrupt or partial file is
// therefore never exposed as an available image.
//
// The package is intentionally independent of the control plane: callers
// supply a Manifest and choose the storage directory. It uses only the Go
// standard library.
package imagedownload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultMaxSize is the default upper bound for a downloaded image
	// (64 GiB). It protects against servers that never stop sending data.
	DefaultMaxSize int64 = 64 << 30
	// DefaultMaxRedirects is the default number of redirects to follow.
	DefaultMaxRedirects = 10

	partialSuffix    = ".partial"
	copyBufferSize   = 256 << 10
	progressInterval = 200 * time.Millisecond
)

var (
	// ErrInvalidManifest reports a missing or unsafe manifest field.
	ErrInvalidManifest = errors.New("imagedownload: invalid manifest")
	// ErrInvalidStorageDir reports an unusable storage directory.
	ErrInvalidStorageDir = errors.New("imagedownload: invalid storage directory")
	// ErrUnsafeTarget reports a target or partial path that is not a regular
	// file (for example a symlink or directory).
	ErrUnsafeTarget = errors.New("imagedownload: unsafe target path")
	// ErrTooManyRedirects reports that the redirect limit was exceeded or a
	// redirect pointed at an unsupported scheme.
	ErrTooManyRedirects = errors.New("imagedownload: too many redirects")
	// ErrHTTPStatus reports an unexpected HTTP response status.
	ErrHTTPStatus = errors.New("imagedownload: unexpected HTTP status")
	// ErrRangeRejected reports HTTP 416. The partial file is removed so a
	// later attempt can safely start from zero.
	ErrRangeRejected = errors.New("imagedownload: server rejected the resume range")
	// ErrInvalidResponse reports a malformed or inconsistent HTTP response.
	ErrInvalidResponse = errors.New("imagedownload: invalid HTTP response")
	// ErrSizeExceeded reports that the image exceeds the configured limit.
	ErrSizeExceeded = errors.New("imagedownload: image exceeds allowed size")
	// ErrSizeMismatch reports that the downloaded size does not match the
	// manifest or the server's declared size.
	ErrSizeMismatch = errors.New("imagedownload: image size mismatch")
	// ErrChecksumMismatch reports that the downloaded bytes do not match the
	// manifest SHA-256. The partial file is removed.
	ErrChecksumMismatch = errors.New("imagedownload: SHA-256 mismatch")
)

// Manifest describes one downloadable image.
//
// SHA256 is required and must contain 64 hexadecimal characters. Size is
// optional: zero means unknown. When Size is set it is enforced against both
// the server metadata and the final file.
type Manifest struct {
	URL      string
	FileName string
	Size     int64
	SHA256   string
}

// Result describes a successful download. A Result is only returned for a
// final file whose size and SHA-256 have been verified.
type Result struct {
	Path   string
	Size   int64
	SHA256 string
	// AlreadyPresent is true when a previously verified final file was reused
	// (including a concurrent caller that completed the same target first).
	AlreadyPresent bool
	// ResumedFrom is the number of partial bytes that were retained and
	// appended to. It is zero when no partial was reused.
	ResumedFrom int64
	// RangeIgnored is true when a partial existed but the server answered the
	// ranged request with a full 200 response. The download restarted from
	// zero and the partial was truncated before writing.
	RangeIgnored bool
	Duration     time.Duration
}

// Progress is delivered to the optional Progress callback. TotalBytes is zero
// when the total size is unknown.
type Progress struct {
	FileName        string
	DownloadedBytes int64
	TotalBytes      int64
	ResumedFrom     int64
	RangeIgnored    bool
}

// ProgressFunc receives throttled download progress. It is called from the
// goroutine performing the transfer and must not block for long. When
// concurrent callers coalesce on the same target, only the goroutine that
// performs the download receives progress; the waiting callers receive the
// verified Result.
type ProgressFunc func(Progress)

// Downloader downloads and verifies images into StorageDir. Use New to apply
// defaults; a zero-value Downloader with StorageDir set also works and keeps
// partial files on transient errors.
//
// Download is safe for concurrent use with different targets. Configuration
// fields must not be mutated while downloads are in flight.
type Downloader struct {
	// StorageDir is the directory that receives images. It is created on
	// demand, which allows callers to use a user-selected data directory.
	StorageDir string
	// MaxSize caps a single image. Zero means DefaultMaxSize; a negative
	// value disables the cap (not recommended).
	MaxSize int64
	// MaxRedirects caps HTTP redirects. Zero means DefaultMaxRedirects.
	MaxRedirects int
	// DeletePartialOnError removes a partial file after transient failures
	// such as network errors or cancellation. The default (false) keeps the
	// partial so a later call can resume. Integrity failures and oversized
	// partials are always removed because they cannot be trusted.
	DeletePartialOnError bool
	// Progress, when set, receives throttled byte progress.
	Progress ProgressFunc

	client     *http.Client
	clientOnce sync.Once

	mu    sync.Mutex
	locks map[string]*targetEntry
}

// New returns a Downloader with production defaults for storageDir.
func New(storageDir string) *Downloader {
	return &Downloader{
		StorageDir:   storageDir,
		MaxSize:      DefaultMaxSize,
		MaxRedirects: DefaultMaxRedirects,
	}
}

// IsIntegrityError reports whether err is a size or checksum failure. Callers
// should not blindly retry resumed bytes after an integrity error; this
// package removes the offending partial before returning such an error.
func IsIntegrityError(err error) bool {
	return errors.Is(err, ErrSizeExceeded) ||
		errors.Is(err, ErrSizeMismatch) ||
		errors.Is(err, ErrChecksumMismatch)
}

type targetEntry struct {
	sem  chan struct{}
	refs int
}

// Download fetches manifest into the storage directory. Concurrent calls for
// the same final path are serialized; the later caller reuses and re-verifies
// the final file instead of downloading it again.
//
// The returned Result is never produced from an unverified file. On failure
// the final path is absent; a partial file may remain for resume unless
// DeletePartialOnError is set or the failure was an integrity failure.
func (d *Downloader) Download(ctx context.Context, manifest Manifest) (Result, error) {
	start := time.Now()
	if ctx == nil {
		return Result{}, fmt.Errorf("%w: nil context", ErrInvalidManifest)
	}

	maxSize := d.effectiveMaxSize()
	normalized, err := normalizeManifest(manifest, maxSize)
	if err != nil {
		return Result{}, err
	}
	if d.StorageDir == "" {
		return Result{}, fmt.Errorf("%w: empty storage directory", ErrInvalidStorageDir)
	}
	storageDir, err := filepath.Abs(d.StorageDir)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %s: %v", ErrInvalidStorageDir, d.StorageDir, err)
	}
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		return Result{}, fmt.Errorf("%w: %s: %v", ErrInvalidStorageDir, storageDir, err)
	}

	finalPath := filepath.Join(storageDir, normalized.FileName)
	partialPath := finalPath + partialSuffix

	release, err := d.acquireTarget(ctx, finalPath)
	if err != nil {
		return Result{}, fmt.Errorf("imagedownload: wait for target %s: %w", finalPath, err)
	}
	defer release()

	// A caller may have expired while another download held the target.
	if err := ctx.Err(); err != nil {
		return Result{}, fmt.Errorf("imagedownload: %s: %w", normalized.FileName, err)
	}

	state, finalSize, err := verifyFile(finalPath, normalized)
	if err != nil {
		return Result{}, err
	}
	switch state {
	case fileValid:
		return Result{
			Path:           finalPath,
			Size:           finalSize,
			SHA256:         normalized.SHA256,
			AlreadyPresent: true,
			Duration:       time.Since(start),
		}, nil
	case fileInvalid:
		// A final file that does not match this manifest must never be
		// reported as available. Remove it and download a verified copy.
		if err := os.Remove(finalPath); err != nil {
			return Result{}, fmt.Errorf("imagedownload: remove invalid final file %s: %w", finalPath, err)
		}
	}

	offset, err := inspectPartial(partialPath)
	if err != nil {
		return Result{}, err
	}
	if offset > 0 && maxSize > 0 && offset > maxSize {
		discardPartial(partialPath)
		offset = 0
	}
	if offset > 0 && normalized.Size > 0 && offset > normalized.Size {
		discardPartial(partialPath)
		offset = 0
	}

	// If a previous process finished writing but crashed before the rename,
	// verify and activate the complete partial without touching the network.
	if offset > 0 && normalized.Size > 0 && offset == normalized.Size {
		state, size, err := verifyFile(partialPath, normalized)
		if err != nil {
			return Result{}, err
		}
		if state == fileValid {
			return d.activate(partialPath, finalPath, size, normalized, offset, false, start)
		}
		discardPartial(partialPath)
		offset = 0
	}

	return d.fetch(ctx, normalized, finalPath, partialPath, offset, maxSize, start)
}

// fetch performs the HTTP transfer and final verification. The caller holds
// the per-target lock.
func (d *Downloader) fetch(
	ctx context.Context,
	manifest Manifest,
	finalPath string,
	partialPath string,
	offset int64,
	maxSize int64,
	start time.Time,
) (Result, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, manifest.URL, nil)
	if err != nil {
		return Result{}, fmt.Errorf("%w: build request: %v", ErrInvalidManifest, err)
	}
	// Keep the image bytes unmodified. Automatic gzip decoding would make
	// Content-Length, Range offsets, and the manifest SHA-256 inconsistent.
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "agent-in-box-imagedownload/1")
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}

	response, err := d.httpClient().Do(request)
	if err != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: GET %s: %w", manifest.URL, err)
	}
	defer response.Body.Close()

	if err := ctx.Err(); err != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: %s: %w", manifest.FileName, err)
	}

	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" &&
		!strings.EqualFold(encoding, "identity") {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("%w: unexpected Content-Encoding %q", ErrInvalidResponse, encoding)
	}

	rangeIgnored := false
	writeOffset := offset
	totalSize := manifest.Size

	switch response.StatusCode {
	case http.StatusOK:
		// If we asked for a range and got a full response, the server does
		// not support resume. Restart from zero instead of appending bytes at
		// the wrong offset; this is a real restart, not a fake resume.
		if offset > 0 {
			rangeIgnored = true
			writeOffset = 0
		}
		if response.ContentLength >= 0 {
			if maxSize > 0 && response.ContentLength > maxSize {
				discardPartial(partialPath)
				return Result{}, fmt.Errorf("%w: %d bytes (limit %d)", ErrSizeExceeded, response.ContentLength, maxSize)
			}
			if manifest.Size > 0 && response.ContentLength != manifest.Size {
				discardPartial(partialPath)
				return Result{}, fmt.Errorf(
					"%w: server Content-Length %d, manifest %d",
					ErrSizeMismatch, response.ContentLength, manifest.Size,
				)
			}
			if totalSize == 0 && response.ContentLength > 0 {
				totalSize = response.ContentLength
			}
		}
	case http.StatusPartialContent:
		contentStart, contentEnd, contentTotal, err := parseContentRange(response.Header.Get("Content-Range"))
		if err != nil {
			return Result{}, err
		}
		if contentStart != offset {
			discardPartial(partialPath)
			return Result{}, fmt.Errorf(
				"%w: server range starts at %d, partial ends at %d",
				ErrInvalidResponse, contentStart, offset,
			)
		}
		if contentTotal >= 0 {
			if maxSize > 0 && contentTotal > maxSize {
				discardPartial(partialPath)
				return Result{}, fmt.Errorf("%w: %d bytes (limit %d)", ErrSizeExceeded, contentTotal, maxSize)
			}
			if manifest.Size > 0 && contentTotal != manifest.Size {
				discardPartial(partialPath)
				return Result{}, fmt.Errorf(
					"%w: server total %d, manifest %d",
					ErrSizeMismatch, contentTotal, manifest.Size,
				)
			}
			totalSize = contentTotal
		}
		if manifest.Size > 0 && contentEnd >= manifest.Size {
			discardPartial(partialPath)
			return Result{}, fmt.Errorf(
				"%w: server range ends at %d, manifest %d",
				ErrSizeMismatch, contentEnd, manifest.Size,
			)
		}
		if response.ContentLength >= 0 && response.ContentLength != contentEnd-contentStart+1 {
			return Result{}, fmt.Errorf(
				"%w: Content-Length %d does not match range %d-%d",
				ErrInvalidResponse, response.ContentLength, contentStart, contentEnd,
			)
		}
		if totalSize == 0 && contentTotal > 0 {
			totalSize = contentTotal
		}
	case http.StatusRequestedRangeNotSatisfiable:
		// The server rejected the partial. Remove it so the next attempt can
		// start from zero rather than repeatedly sending the same bad range.
		discardPartial(partialPath)
		return Result{}, fmt.Errorf("%w: %s", ErrRangeRejected, response.Status)
	default:
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			d.abortPartial(partialPath)
			return Result{}, fmt.Errorf("%w: %s: %s", ErrHTTPStatus, manifest.URL, response.Status)
		}
		return Result{}, fmt.Errorf("%w: unsupported status %s", ErrHTTPStatus, response.Status)
	}

	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if writeOffset > 0 {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	file, err := os.OpenFile(partialPath, flags, 0o644)
	if err != nil {
		return Result{}, fmt.Errorf("imagedownload: open partial %s: %w", partialPath, err)
	}
	if writeOffset > 0 {
		info, statErr := file.Stat()
		if statErr != nil {
			_ = file.Close()
			d.abortPartial(partialPath)
			return Result{}, fmt.Errorf("imagedownload: stat partial %s: %w", partialPath, statErr)
		}
		if info.Size() != writeOffset {
			_ = file.Close()
			discardPartial(partialPath)
			return Result{}, fmt.Errorf(
				"imagedownload: partial %s changed size from %d to %d",
				partialPath, writeOffset, info.Size(),
			)
		}
	}

	reporter := &progressReporter{
		fn:           d.Progress,
		fileName:     manifest.FileName,
		total:        totalSize,
		resumedFrom:  writeOffset,
		rangeIgnored: rangeIgnored,
	}
	reporter.emit(writeOffset, true)

	written, copyErr := copyBody(ctx, file, response.Body, manifest, writeOffset, maxSize, reporter)
	syncErr := file.Sync()
	closeErr := file.Close()

	if copyErr != nil {
		if IsIntegrityError(copyErr) {
			discardPartial(partialPath)
		} else {
			d.abortPartial(partialPath)
		}
		return Result{}, copyErr
	}
	// Emit a final progress event for the complete byte count even when the
	// verification below fails.
	reporter.emit(writeOffset+written, true)
	if syncErr != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: sync partial %s: %w", partialPath, syncErr)
	}
	if closeErr != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: close partial %s: %w", partialPath, closeErr)
	}

	info, err := os.Stat(partialPath)
	if err != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: stat partial %s: %w", partialPath, err)
	}
	actualSize := info.Size()
	if actualSize != writeOffset+written {
		discardPartial(partialPath)
		return Result{}, fmt.Errorf(
			"%w: wrote %d bytes but partial is %d bytes",
			ErrSizeMismatch, writeOffset+written, actualSize,
		)
	}
	if manifest.Size > 0 && actualSize != manifest.Size {
		discardPartial(partialPath)
		return Result{}, fmt.Errorf("%w: got %d bytes, want %d", ErrSizeMismatch, actualSize, manifest.Size)
	}

	sum, err := hashFile(partialPath)
	if err != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: hash partial %s: %w", partialPath, err)
	}
	if sum != manifest.SHA256 {
		discardPartial(partialPath)
		return Result{}, fmt.Errorf(
			"%w: %s: got %s, want %s",
			ErrChecksumMismatch, manifest.FileName, sum, manifest.SHA256,
		)
	}

	return d.activate(partialPath, finalPath, actualSize, manifest, writeOffset, rangeIgnored, start)
}

// activate atomically renames a verified partial into place.
func (d *Downloader) activate(
	partialPath string,
	finalPath string,
	size int64,
	manifest Manifest,
	resumedFrom int64,
	rangeIgnored bool,
	start time.Time,
) (Result, error) {
	if err := os.Rename(partialPath, finalPath); err != nil {
		d.abortPartial(partialPath)
		return Result{}, fmt.Errorf("imagedownload: activate %s: %w", finalPath, err)
	}
	// make the rename durable on filesystems that support directory fsync
	syncDir(filepath.Dir(finalPath))
	return Result{
		Path:         finalPath,
		Size:         size,
		SHA256:       manifest.SHA256,
		ResumedFrom:  resumedFrom,
		RangeIgnored: rangeIgnored,
		Duration:     time.Since(start),
	}, nil
}

func copyBody(
	ctx context.Context,
	dst io.Writer,
	src io.Reader,
	manifest Manifest,
	writeOffset int64,
	maxSize int64,
	reporter *progressReporter,
) (int64, error) {
	buffer := make([]byte, copyBufferSize)
	var written int64

	for {
		if err := ctx.Err(); err != nil {
			return written, fmt.Errorf("imagedownload: %s: %w", manifest.FileName, err)
		}

		n, readErr := src.Read(buffer)
		if n > 0 {
			if maxSize > 0 && writeOffset+written+int64(n) > maxSize {
				return written, fmt.Errorf(
					"%w: exceeds %d-byte limit", ErrSizeExceeded, maxSize,
				)
			}
			if manifest.Size > 0 && writeOffset+written+int64(n) > manifest.Size {
				return written, fmt.Errorf(
					"%w: server sent more than the manifest's %d bytes",
					ErrSizeMismatch, manifest.Size,
				)
			}
			if _, err := dst.Write(buffer[:n]); err != nil {
				return written, fmt.Errorf("imagedownload: write partial: %w", err)
			}
			written += int64(n)
			reporter.emit(writeOffset+written, false)
			if err := ctx.Err(); err != nil {
				return written, fmt.Errorf("imagedownload: %s: %w", manifest.FileName, err)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return written, nil
			}
			return written, fmt.Errorf("imagedownload: read body: %w", readErr)
		}
	}
}

func (d *Downloader) acquireTarget(ctx context.Context, key string) (func(), error) {
	d.mu.Lock()
	if d.locks == nil {
		d.locks = make(map[string]*targetEntry)
	}
	entry := d.locks[key]
	if entry == nil {
		entry = &targetEntry{sem: make(chan struct{}, 1)}
		d.locks[key] = entry
	}
	entry.refs++
	d.mu.Unlock()

	select {
	case entry.sem <- struct{}{}:
		return func() {
			<-entry.sem
			d.releaseTarget(key, entry)
		}, nil
	case <-ctx.Done():
		d.releaseTarget(key, entry)
		return nil, ctx.Err()
	}
}

func (d *Downloader) releaseTarget(key string, entry *targetEntry) {
	d.mu.Lock()
	entry.refs--
	if entry.refs == 0 {
		delete(d.locks, key)
	}
	d.mu.Unlock()
}

func (d *Downloader) httpClient() *http.Client {
	d.clientOnce.Do(func() {
		if d.client != nil {
			return
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ResponseHeaderTimeout = 60 * time.Second
		d.client = &http.Client{
			Transport: transport,
			CheckRedirect: func(request *http.Request, via []*http.Request) error {
				maxRedirects := d.MaxRedirects
				if maxRedirects <= 0 {
					maxRedirects = DefaultMaxRedirects
				}
				if len(via) > maxRedirects {
					return fmt.Errorf("%w: stopped after %d redirects", ErrTooManyRedirects, maxRedirects)
				}
				if request.URL.Scheme != "http" && request.URL.Scheme != "https" {
					return fmt.Errorf(
						"%w: redirect to unsupported scheme %q",
						ErrTooManyRedirects, request.URL.Scheme,
					)
				}
				return nil
			},
		}
	})
	return d.client
}

func (d *Downloader) effectiveMaxSize() int64 {
	switch {
	case d.MaxSize < 0:
		return 0 // explicitly unlimited
	case d.MaxSize == 0:
		return DefaultMaxSize
	default:
		return d.MaxSize
	}
}

// abortPartial applies the transient-failure policy. Integrity failures must
// use discardPartial instead.
func (d *Downloader) abortPartial(path string) {
	if d.DeletePartialOnError {
		discardPartial(path)
	}
}

func discardPartial(path string) {
	_ = os.Remove(path)
}

type fileState int

const (
	fileMissing fileState = iota
	fileValid
	fileInvalid
)

// verifyFile checks an existing final or complete partial file.
func verifyFile(path string, manifest Manifest) (fileState, int64, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return fileMissing, 0, nil
	}
	if err != nil {
		return fileMissing, 0, fmt.Errorf("imagedownload: stat %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fileInvalid, info.Size(), fmt.Errorf("%w: %s is not a regular file", ErrUnsafeTarget, path)
	}
	size := info.Size()
	if manifest.Size > 0 && size != manifest.Size {
		return fileInvalid, size, nil
	}
	sum, err := hashFile(path)
	if err != nil {
		return fileInvalid, size, fmt.Errorf("imagedownload: hash %s: %w", path, err)
	}
	if sum != manifest.SHA256 {
		return fileInvalid, size, nil
	}
	return fileValid, size, nil
}

func inspectPartial(path string) (int64, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("imagedownload: stat partial %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return 0, fmt.Errorf("%w: partial %s is not a regular file", ErrUnsafeTarget, path)
	}
	return info.Size(), nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// parseContentRange parses "bytes START-END/TOTAL" and "bytes START-END/*".
// A total of -1 means the server did not declare one.
func parseContentRange(value string) (start, end, total int64, err error) {
	value = strings.TrimSpace(value)
	const prefix = "bytes "
	if !strings.HasPrefix(value, prefix) {
		return 0, 0, 0, fmt.Errorf("%w: missing or malformed Content-Range %q", ErrInvalidResponse, value)
	}
	spec := strings.TrimSpace(strings.TrimPrefix(value, prefix))
	rangePart, totalPart, ok := strings.Cut(spec, "/")
	if !ok {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range %q", ErrInvalidResponse, value)
	}
	startPart, endPart, ok := strings.Cut(rangePart, "-")
	if !ok {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range %q", ErrInvalidResponse, value)
	}

	start, err = strconv.ParseInt(startPart, 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range start %q", ErrInvalidResponse, startPart)
	}
	end, err = strconv.ParseInt(endPart, 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range end %q", ErrInvalidResponse, endPart)
	}
	if start < 0 || end < start {
		return 0, 0, 0, fmt.Errorf("%w: invalid Content-Range %q", ErrInvalidResponse, value)
	}

	if strings.TrimSpace(totalPart) == "*" {
		total = -1
	} else {
		total, err = strconv.ParseInt(totalPart, 10, 64)
		if err != nil || total <= end {
			return 0, 0, 0, fmt.Errorf("%w: invalid Content-Range total %q", ErrInvalidResponse, totalPart)
		}
	}
	return start, end, total, nil
}

func normalizeManifest(manifest Manifest, maxSize int64) (Manifest, error) {
	parsedURL, err := url.Parse(manifest.URL)
	if err != nil || parsedURL.Host == "" ||
		(parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return Manifest{}, fmt.Errorf("%w: URL must be http(s) with a host: %q", ErrInvalidManifest, manifest.URL)
	}

	name := manifest.FileName
	if err := validateFileName(name); err != nil {
		return Manifest{}, err
	}

	sum := strings.ToLower(strings.TrimSpace(manifest.SHA256))
	if len(sum) != 64 {
		return Manifest{}, fmt.Errorf("%w: SHA256 must be 64 hexadecimal characters", ErrInvalidManifest)
	}
	if _, err := hex.DecodeString(sum); err != nil {
		return Manifest{}, fmt.Errorf("%w: SHA256 is not hexadecimal", ErrInvalidManifest)
	}

	if manifest.Size < 0 {
		return Manifest{}, fmt.Errorf("%w: Size must be zero (unknown) or positive", ErrInvalidManifest)
	}
	if maxSize > 0 && manifest.Size > maxSize {
		return Manifest{}, fmt.Errorf(
			"%w: Size %d exceeds the %d-byte limit", ErrInvalidManifest, manifest.Size, maxSize,
		)
	}

	return Manifest{
		URL:      manifest.URL,
		FileName: name,
		Size:     manifest.Size,
		SHA256:   sum,
	}, nil
}

func validateFileName(name string) error {
	if name == "" || name == "." || name == ".." {
		return fmt.Errorf("%w: invalid file name %q", ErrInvalidManifest, name)
	}
	if len(name) > 255 {
		return fmt.Errorf("%w: file name is longer than 255 bytes", ErrInvalidManifest)
	}
	if strings.TrimSpace(name) != name {
		return fmt.Errorf("%w: file name has leading or trailing whitespace", ErrInvalidManifest)
	}
	// Reject separators, Windows-invalid characters, control bytes, and
	// names that could escape the storage directory.
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: file name contains a control character", ErrInvalidManifest)
		}
		if strings.ContainsRune(`<>:"/\|?*`, r) {
			return fmt.Errorf("%w: file name contains %q", ErrInvalidManifest, r)
		}
	}
	if strings.HasSuffix(name, ".") {
		return fmt.Errorf("%w: file name ends with a dot", ErrInvalidManifest)
	}
	if filepath.Base(name) != name || filepath.IsAbs(name) {
		return fmt.Errorf("%w: file name must not contain a path", ErrInvalidManifest)
	}
	return nil
}

func syncDir(dir string) {
	file, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = file.Sync()
	_ = file.Close()
}

type progressReporter struct {
	fn           ProgressFunc
	fileName     string
	total        int64
	resumedFrom  int64
	rangeIgnored bool
	last         time.Time
	lastBytes    int64
}

func (r *progressReporter) emit(downloaded int64, force bool) {
	if r.fn == nil {
		return
	}
	now := time.Now()
	firstBytes := r.lastBytes == 0 && downloaded > 0
	if !force && !firstBytes && now.Sub(r.last) < progressInterval {
		return
	}
	r.last = now
	r.lastBytes = downloaded
	r.fn(Progress{
		FileName:        r.fileName,
		DownloadedBytes: downloaded,
		TotalBytes:      r.total,
		ResumedFrom:     r.resumedFrom,
		RangeIgnored:    r.rangeIgnored,
	})
}
