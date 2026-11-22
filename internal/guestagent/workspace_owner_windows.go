//go:build windows

package guestagent

type workspaceOwner struct {
	valid bool
}

func workspaceOwnerAt(string) (workspaceOwner, error) {
	return workspaceOwner{}, nil
}

func applyWorkspaceOwner(string, workspaceOwner) error {
	// Windows ownership is inherited through the controlled parent-directory ACL.
	return nil
}
