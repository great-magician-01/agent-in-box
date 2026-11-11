// Package guestagent implements the in-guest authenticated desktop control
// service. It runs inside the VM only and never exposes host execution.
package guestagent

// Point is a logical desktop coordinate.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// InputRequest mirrors the shared Computer Use action protocol.
type InputRequest struct {
	// ActionID is an optional caller-supplied idempotency key. The server
	// generates one when it is empty and rejects ids that were already used.
	ActionID string `json:"actionId,omitempty"`
	// TimeoutMillis optionally bounds this action. The server clamps it to its
	// own maximum action timeout.
	TimeoutMillis int      `json:"timeoutMs,omitempty"`
	Type          string   `json:"type"`
	Point         *Point   `json:"point,omitempty"`
	Button        string   `json:"button,omitempty"`
	Count         int      `json:"count,omitempty"`
	DeltaX        float64  `json:"deltaX,omitempty"`
	DeltaY        float64  `json:"deltaY,omitempty"`
	Text          string   `json:"text,omitempty"`
	Keys          []string `json:"keys,omitempty"`
	From          *Point   `json:"from,omitempty"`
	To            *Point   `json:"to,omitempty"`
	Milliseconds  int      `json:"milliseconds,omitempty"`
}

// ActionResult is returned for every accepted or rejected input action.
type ActionResult struct {
	ActionID  string `json:"actionId"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// VerifyCheck is a read-only evidence check used to verify task completion.
// The guest agent never returns file contents.
type VerifyCheck struct {
	Type      string `json:"type"`
	Path      string `json:"path,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	SizeBytes *int64 `json:"sizeBytes,omitempty"`
	Name      string `json:"name,omitempty"`
}

// VerifyRequest is bounded independently from input actions.
type VerifyRequest struct {
	ActionID      string        `json:"actionId,omitempty"`
	TimeoutMillis int           `json:"timeoutMs,omitempty"`
	Checks        []VerifyCheck `json:"checks"`
}

// VerifyCheckResult reports metadata for one independent completion check.
type VerifyCheckResult struct {
	Type       string `json:"type"`
	OK         bool   `json:"ok"`
	ErrorCode  string `json:"errorCode,omitempty"`
	Error      string `json:"error,omitempty"`
	Path       string `json:"path,omitempty"`
	SizeBytes  int64  `json:"sizeBytes,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
	PIDs       []int  `json:"pids,omitempty"`
}

// VerifyResult aggregates the independent checks for a completion request.
type VerifyResult struct {
	ActionID string              `json:"actionId"`
	OK       bool                `json:"ok"`
	Checks   []VerifyCheckResult `json:"checks"`
	Error    string              `json:"error,omitempty"`
}

// DesktopInfo describes the active guest display and interactive session
// state. Windows lock/UAC secure desktops are reported instead of bypassed.
type DesktopInfo struct {
	DisplayServer string  `json:"displayServer"`
	Width         int     `json:"width"`
	Height        int     `json:"height"`
	DPI           float64 `json:"dpi"`
	ScaleFactor   float64 `json:"scaleFactor"`
	SessionState  string  `json:"sessionState,omitempty"`
	Locked        bool    `json:"locked,omitempty"`
	SecureDesktop bool    `json:"secureDesktop,omitempty"`
}

// Capabilities advertises what this guest build can actually do.
type Capabilities struct {
	ProtocolVersion string `json:"protocolVersion"`
	// AgentVersion is the explicit build version injected at link time.
	AgentVersion  string `json:"agentVersion"`
	Platform      string `json:"platform"`
	DisplayServer string `json:"displayServer"`
	Screenshot    bool   `json:"screenshot"`
	Input         bool   `json:"input"`
	UnicodeInput  bool   `json:"unicodeInput"`
	SessionState  string `json:"sessionState,omitempty"`
}

// VersionInfo is the host-facing version handshake.
type VersionInfo struct {
	AgentVersion             string `json:"agentVersion"`
	ProtocolVersion          string `json:"protocolVersion"`
	MinimumProtocolVersion   string `json:"minimumProtocolVersion"`
	MaximumProtocolVersion   string `json:"maximumProtocolVersion"`
	RequestedProtocolVersion string `json:"requestedProtocolVersion,omitempty"`
	Compatible               bool   `json:"compatible"`
	CompatibilityError       string `json:"compatibilityError,omitempty"`
}

// Heartbeat reports that the agent loop is alive and whether the desktop
// driver is currently usable. It deliberately does not fail when the desktop
// is broken: callers need liveness and version information even then.
type Heartbeat struct {
	Status                   string `json:"status"`
	AgentVersion             string `json:"agentVersion"`
	ProtocolVersion          string `json:"protocolVersion"`
	Compatible               bool   `json:"compatible"`
	RequestedProtocolVersion string `json:"requestedProtocolVersion,omitempty"`
	CompatibilityError       string `json:"compatibilityError,omitempty"`
	DesktopAvailable         bool   `json:"desktopAvailable"`
	Platform                 string `json:"platform"`
	DisplayServer            string `json:"displayServer,omitempty"`
	SessionState             string `json:"sessionState,omitempty"`
	DesktopError             string `json:"desktopError,omitempty"`
	UptimeSeconds            int64  `json:"uptimeSeconds"`
	Now                      string `json:"now"`
}

// UpdateManifest describes a guest-agent build that may be staged. The size
// and SHA-256 are mandatory; the guest agent never executes the staged file.
type UpdateManifest struct {
	ActionID        string `json:"actionId,omitempty"`
	Version         string `json:"version"`
	URL             string `json:"url"`
	SizeBytes       int64  `json:"sizeBytes"`
	SHA256          string `json:"sha256"`
	ProtocolVersion string `json:"protocolVersion,omitempty"`
	OS              string `json:"os,omitempty"`
	Architecture    string `json:"architecture,omitempty"`
}

// UpdateCompatibility explains whether a staged build can be activated by the
// current host/guest combination. Compatibility is advisory for updates that
// need an external service manager to activate them.
type UpdateCompatibility struct {
	Compatible             bool     `json:"compatible"`
	CurrentProtocolVersion string   `json:"currentProtocolVersion"`
	TargetProtocolVersion  string   `json:"targetProtocolVersion,omitempty"`
	CurrentOS              string   `json:"currentOs"`
	TargetOS               string   `json:"targetOs,omitempty"`
	CurrentArchitecture    string   `json:"currentArchitecture"`
	TargetArchitecture     string   `json:"targetArchitecture,omitempty"`
	Reasons                []string `json:"reasons,omitempty"`
}

// UpdateResult is returned after a verified build has been staged. The agent
// does not restart itself; a service manager activates the new build.
type UpdateResult struct {
	ActionID        string              `json:"actionId"`
	OK              bool                `json:"ok"`
	Version         string              `json:"version,omitempty"`
	SizeBytes       int64               `json:"sizeBytes,omitempty"`
	SHA256          string              `json:"sha256,omitempty"`
	StagedPath      string              `json:"stagedPath,omitempty"`
	AlreadyStaged   bool                `json:"alreadyStaged,omitempty"`
	RestartRequired bool                `json:"restartRequired"`
	Activation      string              `json:"activation"`
	Compatibility   UpdateCompatibility `json:"compatibility"`
	Error           string              `json:"error,omitempty"`
}
