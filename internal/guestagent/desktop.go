package guestagent

import "errors"

// Session-boundary errors are shared by the HTTP layer so a locked Windows
// session or UAC secure desktop is reported as a human-takeover condition, not
// as a generic screenshot/input failure that a Worker might retry.
var (
	ErrSessionLocked = errors.New("Windows session is locked; human takeover is required")
	ErrSecureDesktop = errors.New("Windows secure desktop (for example UAC) is active; human takeover is required")
)

// NewDesktop connects to the guest display driver. On unsupported systems it
// returns an error and the health endpoint remains available.
func NewDesktop(display string) (Desktop, error) {
	return newDesktop(display)
}
