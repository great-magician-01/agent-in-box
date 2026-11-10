package guestagent

// NewDesktop connects to the guest display driver. On unsupported systems it
// returns an error and the health endpoint remains available.
func NewDesktop(display string) (Desktop, error) {
	return newDesktop(display)
}
