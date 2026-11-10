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
	Type         string   `json:"type"`
	Point        *Point   `json:"point,omitempty"`
	Button       string   `json:"button,omitempty"`
	Count        int      `json:"count,omitempty"`
	DeltaX       float64  `json:"deltaX,omitempty"`
	DeltaY       float64  `json:"deltaY,omitempty"`
	Text         string   `json:"text,omitempty"`
	Keys         []string `json:"keys,omitempty"`
	From         *Point   `json:"from,omitempty"`
	To           *Point   `json:"to,omitempty"`
	Milliseconds int      `json:"milliseconds,omitempty"`
}

// ActionResult is returned for every accepted or rejected input action.
type ActionResult struct {
	ActionID string `json:"actionId"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// DesktopInfo describes the active guest display.
type DesktopInfo struct {
	DisplayServer string `json:"displayServer"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
}

// Capabilities advertises what this guest build can actually do.
type Capabilities struct {
	ProtocolVersion string `json:"protocolVersion"`
	DisplayServer   string `json:"displayServer"`
	Screenshot      bool   `json:"screenshot"`
	Input           bool   `json:"input"`
	UnicodeInput    bool   `json:"unicodeInput"`
}
