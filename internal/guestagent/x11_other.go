//go:build !linux

package guestagent

import "fmt"

func newDesktop(display string) (Desktop, error) {
	return nil, fmt.Errorf("guest desktop control is currently implemented for Linux X11 only")
}
