package guestagent

import (
	"archive/tar"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const defaultMaxWorkspaceArchiveBytes int64 = 512 << 20

// archiveWorkspace streams a bounded tar.gz of one configured workspace root.
// Symlinks are rejected instead of being followed or silently dropped.
func (s *Server) archiveWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeActionError(w, http.StatusMethodNotAllowed, "", "method_not_allowed", "method not allowed")
		return
	}
	workspace, err := s.resolveWorkspacePath(r.URL.Query().Get("path"))
	if err != nil {
		writeActionError(w, http.StatusBadRequest, "", "invalid_workspace", err.Error())
		return
	}
	info, err := os.Stat(workspace)
	if err != nil || !info.IsDir() {
		writeActionError(w, http.StatusBadRequest, "", "invalid_workspace", "workspace must be an existing directory")
		return
	}
	temp, err := os.CreateTemp("", "agent-in-box-workspace-*.tar.gz")
	if err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", "could not create archive")
		return
	}
	defer func() {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
	}()

	hash := sha256.New()
	multi := io.MultiWriter(temp, hash)
	gzipWriter := gzip.NewWriter(multi)
	tarWriter := tar.NewWriter(gzipWriter)
	var fileCount int
	var totalBytes int64
	walkErr := filepath.WalkDir(workspace, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == workspace {
			return nil
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("workspace contains a symbolic link: %s", current)
		}
		if !entryInfo.Mode().IsRegular() && !entryInfo.IsDir() {
			return fmt.Errorf("workspace contains an unsupported file type: %s", current)
		}
		relative, err := filepath.Rel(workspace, current)
		if err != nil {
			return err
		}
		header, err := tar.FileInfoHeader(entryInfo, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		header.Uid = 0
		header.Gid = 0
		header.Uname = ""
		header.Gname = ""
		if entryInfo.IsDir() && !strings.HasSuffix(header.Name, "/") {
			header.Name += "/"
		}
		if entryInfo.Mode().IsRegular() {
			if entryInfo.Size() < 0 || totalBytes+entryInfo.Size() > s.maxWorkspaceArchiveBytes {
				return errors.New("workspace exceeds the archive size limit")
			}
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}
		if !entryInfo.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(current)
		if err != nil {
			return err
		}
		written, copyErr := io.CopyN(tarWriter, file, entryInfo.Size())
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if written != entryInfo.Size() {
			return fmt.Errorf("workspace file changed while archiving: %s", current)
		}
		fileCount++
		totalBytes += written
		return nil
	})
	if walkErr != nil {
		writeActionError(w, http.StatusBadRequest, "", "workspace_archive_failed", walkErr.Error())
		return
	}
	if err := tarWriter.Close(); err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	if err := gzipWriter.Close(); err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	if err := temp.Sync(); err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	stat, err := temp.Stat()
	if err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	if stat.Size() > s.maxWorkspaceArchiveBytes {
		writeActionError(w, http.StatusBadRequest, "", "workspace_too_large",
			"workspace archive exceeds the size limit")
		return
	}
	if _, err := temp.Seek(0, io.SeekStart); err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
	w.Header().Set("X-Agent-In-Box-Sha256", hex.EncodeToString(hash.Sum(nil)))
	w.Header().Set("X-Agent-In-Box-Files", fmt.Sprintf("%d", fileCount))
	w.Header().Set("X-Agent-In-Box-Workspace-Bytes", fmt.Sprintf("%d", totalBytes))
	http.ServeContent(w, r, "workspace.tar.gz", stat.ModTime(), temp)
}

// restoreWorkspace verifies and atomically replaces a workspace directory.
// Extraction happens in a sibling directory; symlinks and path escapes are rejected.
func (s *Server) restoreWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeActionError(w, http.StatusMethodNotAllowed, "", "method_not_allowed", "method not allowed")
		return
	}
	workspace, err := s.resolveWorkspacePath(r.URL.Query().Get("path"))
	if err != nil {
		writeActionError(w, http.StatusBadRequest, "", "invalid_workspace", err.Error())
		return
	}
	expectedSha := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Agent-In-Box-Sha256")))
	if expectedSha != "" && !validSha256(expectedSha) {
		writeActionError(w, http.StatusBadRequest, "", "invalid_checksum", "invalid workspace SHA-256")
		return
	}
	upload, err := os.CreateTemp("", "agent-in-box-workspace-upload-*.tar.gz")
	if err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", "could not stage upload")
		return
	}
	uploadPath := upload.Name()
	defer os.Remove(uploadPath)
	hash := sha256.New()
	limited := http.MaxBytesReader(w, r.Body, s.maxWorkspaceArchiveBytes)
	_, err = io.Copy(io.MultiWriter(upload, hash), limited)
	closeErr := upload.Close()
	if err != nil {
		writeActionError(w, http.StatusRequestEntityTooLarge, "", "archive_too_large", "workspace archive exceeds the size limit")
		return
	}
	if closeErr != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", closeErr.Error())
		return
	}
	actualSha := hex.EncodeToString(hash.Sum(nil))
	if expectedSha != "" && subtle.ConstantTimeCompare([]byte(expectedSha), []byte(actualSha)) != 1 {
		writeActionError(w, http.StatusBadRequest, "", "checksum_mismatch", "workspace archive SHA-256 does not match")
		return
	}

	parent := filepath.Dir(workspace)
	if _, err := os.Stat(parent); err != nil {
		writeActionError(w, http.StatusBadRequest, "", "invalid_workspace", "workspace parent directory does not exist")
		return
	}
	staging, err := os.MkdirTemp(parent, "."+filepath.Base(workspace)+".restore-")
	if err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", "could not stage workspace restore")
		return
	}
	cleanupStaging := true
	defer func() {
		if cleanupStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	fileCount, extractedBytes, err := extractWorkspaceArchive(uploadPath, staging, s.maxWorkspaceArchiveBytes)
	if err != nil {
		writeActionError(w, http.StatusBadRequest, "", "workspace_restore_failed", err.Error())
		return
	}

	suffix, err := randomSuffix()
	if err != nil {
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", err.Error())
		return
	}
	backup := workspace + ".pre-restore-" + suffix
	hadPrevious := false
	if _, statErr := os.Lstat(workspace); statErr == nil {
		if err := os.Rename(workspace, backup); err != nil {
			writeActionError(w, http.StatusInternalServerError, "", "unavailable", "could not move existing workspace")
			return
		}
		hadPrevious = true
	}
	if err := os.Rename(staging, workspace); err != nil {
		if hadPrevious {
			_ = os.Rename(backup, workspace)
		}
		writeActionError(w, http.StatusInternalServerError, "", "unavailable", "could not activate restored workspace")
		return
	}
	cleanupStaging = false
	if hadPrevious {
		_ = os.RemoveAll(backup)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"path":      workspace,
		"fileCount": fileCount,
		"sizeBytes": extractedBytes,
		"sha256":    actualSha,
	})
}

func (s *Server) resolveWorkspacePath(raw string) (string, error) {
	if len(s.workspaceRoots) == 0 {
		return "", errors.New("workspace operations are disabled")
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("workspace path is required")
	}
	cleaned := filepath.Clean(trimmed)
	if !filepath.IsAbs(cleaned) || filepath.Dir(cleaned) == cleaned ||
		strings.ContainsRune(cleaned, 0) || pathHasParentSegment(cleaned) {
		return "", errors.New("workspace must be a cleaned absolute path without '..' or a filesystem root")
	}
	resolved := cleaned
	if _, err := os.Lstat(cleaned); err == nil {
		real, err := filepath.EvalSymlinks(cleaned)
		if err != nil {
			return "", fmt.Errorf("could not resolve workspace: %w", err)
		}
		resolved = real
	} else if os.IsNotExist(err) {
		parent, err := filepath.EvalSymlinks(filepath.Dir(cleaned))
		if err != nil {
			return "", fmt.Errorf("could not resolve workspace parent: %w", err)
		}
		resolved = filepath.Join(parent, filepath.Base(cleaned))
	} else {
		return "", fmt.Errorf("could not inspect workspace: %w", err)
	}
	for _, root := range s.workspaceRoots {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(realRoot, resolved)
		if err != nil || filepath.IsAbs(relative) || relative == "." || relative == ".." ||
			strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		return resolved, nil
	}
	return "", errors.New("workspace path is outside the configured workspace roots")
}

func extractWorkspaceArchive(archivePath, staging string, maxBytes int64) (int, int64, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid gzip archive: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	var fileCount int
	var entryCount int
	var totalBytes int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, 0, fmt.Errorf("invalid tar archive: %w", err)
		}
		entryCount++
		if entryCount > 100_000 {
			return 0, 0, errors.New("workspace archive contains too many entries")
		}
		cleaned := path.Clean(header.Name)
		if cleaned == "." || strings.HasPrefix(cleaned, "/") || cleaned == ".." ||
			strings.HasPrefix(cleaned, "../") || strings.ContainsRune(cleaned, 0) {
			return 0, 0, fmt.Errorf("unsafe archive entry: %s", header.Name)
		}
		destination := filepath.Join(staging, filepath.FromSlash(cleaned))
		if !pathWithin(staging, destination) {
			return 0, 0, fmt.Errorf("archive entry escapes workspace: %s", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(destination, 0o700); err != nil {
				return 0, 0, err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || totalBytes+header.Size > maxBytes {
				return 0, 0, errors.New("restored workspace exceeds the size limit")
			}
			if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
				return 0, 0, err
			}
			out, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
			if err != nil {
				return 0, 0, err
			}
			copied, copyErr := io.CopyN(out, reader, header.Size)
			closeErr := out.Close()
			if copyErr != nil {
				return 0, 0, copyErr
			}
			if closeErr != nil {
				return 0, 0, closeErr
			}
			if copied != header.Size {
				return 0, 0, errors.New("truncated workspace archive entry")
			}
			fileCount++
			totalBytes += copied
		default:
			return 0, 0, fmt.Errorf("unsupported archive entry type for %s", header.Name)
		}
	}
	return fileCount, totalBytes, nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func randomSuffix() (string, error) {
	buffer := make([]byte, 6)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func validSha256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
