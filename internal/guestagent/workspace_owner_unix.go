//go:build !windows

package guestagent

import (
	"os"
	"path/filepath"
	"syscall"
)

type workspaceOwner struct {
	uid   int
	gid   int
	valid bool
}

func workspaceOwnerAt(workspace string) (workspaceOwner, error) {
	target := workspace
	info, err := os.Stat(target)
	if os.IsNotExist(err) {
		target = filepath.Dir(workspace)
		info, err = os.Stat(target)
	}
	if err != nil {
		return workspaceOwner{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return workspaceOwner{}, nil
	}
	return workspaceOwner{uid: int(stat.Uid), gid: int(stat.Gid), valid: true}, nil
}

func applyWorkspaceOwner(root string, owner workspaceOwner) error {
	if !owner.valid {
		return nil
	}
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chown(path, owner.uid, owner.gid)
	})
}
