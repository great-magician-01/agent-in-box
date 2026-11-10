package vmsupervisor

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// StoragePathOptions supplies OS lookups for tests. Zero values use the real OS.
type StoragePathOptions struct {
	Getenv        func(string) string
	UserConfigDir func() (string, error)
	HomeDir       string
	GOOS          string
}

// DefaultStorageRoot follows the same app-config.json as the control plane so
// a first-run custom data directory also determines VM and ACL token storage.
func DefaultStorageRoot(options StoragePathOptions) (string, error) {
	getenv := options.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	homeDir := options.HomeDir
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return "", err
		}
	}
	if root := getenv("AGENT_IN_BOX_DATA_ROOT"); root != "" {
		return filepath.Abs(filepath.Join(root, "vms"))
	}

	configDir := getenv("AGENT_IN_BOX_CONFIG_DIR")
	if configDir == "" {
		userConfigDir := options.UserConfigDir
		if userConfigDir == nil {
			userConfigDir = os.UserConfigDir
		}
		var err error
		configDir, err = userConfigDir()
		if err != nil {
			return "", err
		}
		configDir = filepath.Join(configDir, "AgentInBox")
	}
	configPath := filepath.Join(configDir, "app-config.json")
	data, err := os.ReadFile(configPath)
	if err == nil {
		var config struct {
			DataRoot string `json:"dataRoot"`
		}
		if err := json.Unmarshal(data, &config); err != nil {
			return "", err
		}
		if config.DataRoot != "" {
			return filepath.Abs(filepath.Join(config.DataRoot, "vms"))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	var root string
	switch goos {
	case "windows":
		root = getenv("LOCALAPPDATA")
		if root == "" {
			root = filepath.Join(homeDir, "AppData", "Local")
		}
		root = filepath.Join(root, "AgentInBox")
	case "darwin":
		root = filepath.Join(homeDir, "Library", "Application Support", "AgentInBox")
	default:
		root = filepath.Join(homeDir, ".local", "share", "agent-in-box")
	}
	return filepath.Abs(filepath.Join(root, "vms"))
}
