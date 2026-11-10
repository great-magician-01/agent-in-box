package vmsupervisor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDefaultStorageRootUsesEnvironmentOverride(t *testing.T) {
	root := filepath.Join(t.TempDir(), "selected root")
	got, err := DefaultStorageRoot(StoragePathOptions{
		Getenv: func(key string) string {
			if key == "AGENT_IN_BOX_DATA_ROOT" {
				return root
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "vms")
	if got != want {
		t.Fatalf("storage root = %q, want %q", got, want)
	}
}

func TestDefaultStorageRootReadsSharedApplicationConfig(t *testing.T) {
	configDir := t.TempDir()
	dataRoot := filepath.Join(t.TempDir(), "自定义 数据")
	if err := os.WriteFile(filepath.Join(configDir, "app-config.json"), []byte(`{"version":1,"dataRoot":`+jsonQuote(dataRoot)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := DefaultStorageRoot(StoragePathOptions{
		Getenv: func(key string) string {
			if key == "AGENT_IN_BOX_CONFIG_DIR" {
				return configDir
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dataRoot, "vms"); got != want {
		t.Fatalf("storage root = %q, want %q", got, want)
	}
}

func TestDefaultStorageRootUsesOSConfigDirectory(t *testing.T) {
	configRoot := t.TempDir()
	dataRoot := filepath.Join(t.TempDir(), "configured")
	if err := os.MkdirAll(filepath.Join(configRoot, "AgentInBox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configRoot, "AgentInBox", "app-config.json"), []byte(`{"dataRoot":`+jsonQuote(dataRoot)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := DefaultStorageRoot(StoragePathOptions{
		Getenv:        func(string) string { return "" },
		UserConfigDir: func() (string, error) { return configRoot, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dataRoot, "vms"); got != want {
		t.Fatalf("storage root = %q, want %q", got, want)
	}
}

func TestDefaultStorageRootRejectsCorruptSharedConfig(t *testing.T) {
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "app-config.json"), []byte(`{bad`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := DefaultStorageRoot(StoragePathOptions{
		Getenv: func(key string) string {
			if key == "AGENT_IN_BOX_CONFIG_DIR" {
				return configDir
			}
			return ""
		},
	})
	if err == nil {
		t.Fatal("expected corrupt app config to fail instead of selecting a different storage root")
	}
}

func TestDefaultStorageRootFallsBackToPlatformDirectory(t *testing.T) {
	home := t.TempDir()
	got, err := DefaultStorageRoot(StoragePathOptions{
		Getenv:        func(string) string { return "" },
		UserConfigDir: func() (string, error) { return filepath.Join(home, "config"), nil },
		HomeDir:       home,
		GOOS:          runtime.GOOS,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == "" || filepath.Base(got) != "vms" {
		t.Fatalf("unexpected default storage root %q", got)
	}
}

func jsonQuote(value string) string {
	// JSON strings need the same escaping as Windows paths and unicode input.
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
