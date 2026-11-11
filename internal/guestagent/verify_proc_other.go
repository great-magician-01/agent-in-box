//go:build !linux

package guestagent

func verifyProcess(check VerifyCheck) VerifyCheckResult {
	return verifyFailure(
		VerifyCheckResult{Type: "process"},
		"process_unsupported",
		"process evidence is only supported on Linux guests",
	)
}
