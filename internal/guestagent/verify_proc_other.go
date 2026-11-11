//go:build !linux && !windows

package guestagent

func verifyProcess(check VerifyCheck) VerifyCheckResult {
	return verifyFailure(
		VerifyCheckResult{Type: "process"},
		"process_unsupported",
		"process evidence is only supported on Linux and Windows guests",
	)
}
