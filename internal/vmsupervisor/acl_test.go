package vmsupervisor

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateListenAddress(t *testing.T) {
	valid := []string{
		"127.0.0.1:7610",
		"127.0.0.2:1",
		"localhost:7610",
		"[::1]:7610",
	}
	for _, address := range valid {
		if err := ValidateListenAddress(address); err != nil {
			t.Fatalf("valid address %q rejected: %v", address, err)
		}
	}

	invalid := []string{
		"0.0.0.0:7610",
		":7610",
		"192.168.1.10:7610",
		"example.com:7610",
		"127.0.0.1",
		"127.0.0.1:not-a-port",
		"[::]:7610",
	}
	for _, address := range invalid {
		if err := ValidateListenAddress(address); err == nil {
			t.Fatalf("invalid address %q accepted", address)
		}
	}
}

func TestResolveACLTokenGeneratesSecureToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "supervisor-acl.token")
	result, err := ResolveACLToken(TokenOptions{
		File:   path,
		Getenv: func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("resolve token: %v", err)
	}
	if len(result.Token) < 32 {
		t.Fatalf("generated token too short: %d", len(result.Token))
	}
	if result.Path != path {
		t.Fatalf("token path: %q", result.Path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read generated token: %v", err)
	}
	if strings.TrimSpace(string(data)) != result.Token {
		t.Fatalf("file token does not match returned token")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("generated token permissions are too open: %o", info.Mode().Perm())
		}
	}

	second, err := ResolveACLToken(TokenOptions{
		File:   path,
		Getenv: func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("re-read token: %v", err)
	}
	if second.Token != result.Token {
		t.Fatalf("re-read token changed: %q != %q", second.Token, result.Token)
	}
}

func TestResolveACLTokenReadsExistingFileAndTrims(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("  file-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ResolveACLToken(TokenOptions{
		File: path,
		Getenv: func(name string) string {
			if name == ACLTokenEnv {
				return "environment-token"
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != "file-token" {
		t.Fatalf("existing token file must win, got %q", result.Token)
	}
}

func TestResolveACLTokenEnvOverrideWhenFileMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	result, err := ResolveACLToken(TokenOptions{
		File: path,
		Getenv: func(name string) string {
			if name == ACLTokenEnv {
				return "dev-override-token"
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != "dev-override-token" {
		t.Fatalf("env override not used: %q", result.Token)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("env override should not create a token file: %v", err)
	}
}

func TestResolveACLTokenEnvFileLocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "env-token")
	if err := os.WriteFile(path, []byte("from-env-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ResolveACLToken(TokenOptions{
		StorageRoot: filepath.Join(t.TempDir(), "unused"),
		Getenv: func(name string) string {
			if name == ACLTokenFileEnv {
				return path
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != path || result.Token != "from-env-file" {
		t.Fatalf("env file token result: %+v", result)
	}
}

func TestDefaultACLTokenPath(t *testing.T) {
	dataRoot := filepath.Join("data", "root")
	storageRoot := filepath.Join(dataRoot, "vms")
	expected := filepath.Join(dataRoot, "supervisor-acl.token")
	if actual := DefaultACLTokenPath(storageRoot); actual != expected {
		t.Fatalf("default path: %q != %q", actual, expected)
	}
}

func TestResolveACLTokenRejectsEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(" \n\t"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveACLToken(TokenOptions{File: path, Getenv: func(string) string { return "" }}); err == nil {
		t.Fatal("expected empty token file error")
	}
}

func TestResolveACLTokenRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires elevated developer mode on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("symlink-target-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	_, err := ResolveACLToken(TokenOptions{File: link, Getenv: func(string) string { return "" }})
	if err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
}

func TestBearerTokenParsing(t *testing.T) {
	cases := []struct {
		header string
		token  string
		ok     bool
	}{
		{"Bearer abc", "abc", true},
		{"bearer abc", "abc", true},
		{"Bearer   abc  ", "abc", true},
		{"Basic abc", "", false},
		{"Bearer", "", false},
		{"Bearer   ", "", false},
		{"", "", false},
	}
	for _, testCase := range cases {
		token, ok := bearerToken(testCase.header)
		if token != testCase.token || ok != testCase.ok {
			t.Fatalf("header %q: got (%q,%t)", testCase.header, token, ok)
		}
	}
	if !tokenMatches("secret", "secret") {
		t.Fatal("matching token rejected")
	}
	if tokenMatches("secret", "secreu") || tokenMatches("secret", "secret-longer") {
		t.Fatal("mismatched token accepted")
	}
}
