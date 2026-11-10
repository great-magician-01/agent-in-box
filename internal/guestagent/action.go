package guestagent

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// ActionIDHeader lets callers supply an action id out of band. It is useful
	// for requests whose body is not JSON, and for authenticated error replies.
	ActionIDHeader = "X-Agent-In-Box-Action-Id"
	// TimeoutHeader lets callers request a per-action timeout in milliseconds.
	// The server clamps it to its configured maximum.
	TimeoutHeader = "X-Agent-In-Box-Timeout-Ms"

	actionTrackerTTL   = 10 * time.Minute
	actionTrackerLimit = 4096
	maxActionIDLength  = 128
)

var actionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// validActionID enforces a non-empty, bounded, log-safe action identifier.
func validActionID(value string) bool {
	return len(value) <= maxActionIDLength && actionIDPattern.MatchString(value)
}

// parseActionIDHeader returns the caller-supplied action id, or "" when the
// header is absent. The second return value is non-empty for invalid ids.
func parseActionIDHeader(r *http.Request) (string, string) {
	value := strings.TrimSpace(r.Header.Get(ActionIDHeader))
	if value == "" {
		return "", ""
	}
	if !validActionID(value) {
		return "", fmt.Sprintf("action id must match %s and be at most %d characters", actionIDPattern.String(), maxActionIDLength)
	}
	return value, ""
}

// mergeActionID validates the combination of a header id and a body id.
func mergeActionID(headerID, bodyID string) (string, string) {
	bodyID = strings.TrimSpace(bodyID)
	if bodyID != "" && !validActionID(bodyID) {
		return "", fmt.Sprintf("action id must match %s and be at most %d characters", actionIDPattern.String(), maxActionIDLength)
	}
	if headerID != "" && bodyID != "" && headerID != bodyID {
		return "", "action id differs between header and body"
	}
	if bodyID != "" {
		return bodyID, ""
	}
	return headerID, ""
}

// timeoutFromRequest combines the timeout header and body field. Zero means
// the server default. Negative or conflicting values are rejected.
func timeoutFromRequest(r *http.Request, bodyMillis int) (time.Duration, string) {
	headerMillis := 0
	rawHeader := strings.TrimSpace(r.Header.Get(TimeoutHeader))
	if rawHeader != "" {
		parsed, err := strconv.Atoi(rawHeader)
		if err != nil || parsed <= 0 {
			return 0, fmt.Sprintf("%s must be a positive integer number of milliseconds", TimeoutHeader)
		}
		headerMillis = parsed
	}
	if bodyMillis < 0 {
		return 0, "timeoutMs must be a positive integer number of milliseconds"
	}
	if headerMillis != 0 && bodyMillis != 0 && headerMillis != bodyMillis {
		return 0, "timeout differs between header and body"
	}
	millis := bodyMillis
	if millis == 0 {
		millis = headerMillis
	}
	if millis == 0 {
		return 0, ""
	}
	// Avoid overflowing time.Duration for absurd values. The server clamps the
	// result to its own maximum before constructing the context.
	if int64(millis) > int64(hardMaxActionTimeout/time.Millisecond) {
		return hardMaxActionTimeout, ""
	}
	return time.Duration(millis) * time.Millisecond, ""
}

// actionTracker bounds the memory used to reject duplicate action ids and
// prevents a caller from replaying an action that was already executed.
type actionTracker struct {
	mu    sync.Mutex
	seen  map[string]time.Time
	ttl   time.Duration
	limit int
	now   func() time.Time
}

func newActionTracker(now func() time.Time) *actionTracker {
	if now == nil {
		now = time.Now
	}
	return &actionTracker{
		seen:  make(map[string]time.Time),
		ttl:   actionTrackerTTL,
		limit: actionTrackerLimit,
		now:   now,
	}
}

// reserve returns false when the id was already used within the retention
// window. It always keeps the tracker bounded, even under sustained load.
func (t *actionTracker) reserve(id string) bool {
	now := t.now()
	for key, seenAt := range t.seen {
		if now.Sub(seenAt) > t.ttl {
			delete(t.seen, key)
		}
	}
	if _, exists := t.seen[id]; exists {
		return false
	}
	if len(t.seen) >= t.limit {
		oldestKey := ""
		var oldest time.Time
		for key, seenAt := range t.seen {
			if oldestKey == "" || seenAt.Before(oldest) {
				oldestKey = key
				oldest = seenAt
			}
		}
		delete(t.seen, oldestKey)
	}
	t.seen[id] = now
	return true
}
