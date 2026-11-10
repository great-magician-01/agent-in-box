package guestagent

import (
	"fmt"
	"regexp"
	"strconv"
)

const (
	// ProtocolVersion is the Host-Guest RPC protocol implemented by this build.
	ProtocolVersion = "0.1.0"
	// MinimumProtocolVersion and MaximumProtocolVersion describe the range the
	// handshake reports to clients. Compatibility is determined by matching the
	// major and minor components.
	MinimumProtocolVersion = "0.1.0"
	MaximumProtocolVersion = "0.1.0"

	// protocolVersion is kept for package-internal callers and tests.
	protocolVersion = ProtocolVersion
)

type numericVersion struct {
	major int
	minor int
	patch int
}

var numericVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func parseNumericVersion(value string) (numericVersion, bool) {
	matches := numericVersionPattern.FindStringSubmatch(value)
	if matches == nil {
		return numericVersion{}, false
	}
	major, err := strconv.Atoi(matches[1])
	if err != nil {
		return numericVersion{}, false
	}
	minor, err := strconv.Atoi(matches[2])
	if err != nil {
		return numericVersion{}, false
	}
	patch, err := strconv.Atoi(matches[3])
	if err != nil {
		return numericVersion{}, false
	}
	return numericVersion{major: major, minor: minor, patch: patch}, true
}

// protocolCompatibility compares a requested Host-Guest protocol with this
// build. Patch releases are wire compatible; major and minor must match.
func protocolCompatibility(requested string) (bool, string) {
	if requested == "" {
		return true, ""
	}
	parsed, ok := parseNumericVersion(requested)
	if !ok {
		return false, "protocolVersion must use MAJOR.MINOR.PATCH"
	}
	current, _ := parseNumericVersion(protocolVersion)
	if parsed.major != current.major || parsed.minor != current.minor {
		return false, fmt.Sprintf("guest protocol %s is incompatible with requested protocol %s", protocolVersion, requested)
	}
	return true, ""
}

func versionInfo(agentVersion string, requested string) VersionInfo {
	compatible, compatibilityError := protocolCompatibility(requested)
	return VersionInfo{
		AgentVersion:             agentVersion,
		ProtocolVersion:          protocolVersion,
		MinimumProtocolVersion:   MinimumProtocolVersion,
		MaximumProtocolVersion:   MaximumProtocolVersion,
		RequestedProtocolVersion: requested,
		Compatible:               compatible,
		CompatibilityError:       compatibilityError,
	}
}
