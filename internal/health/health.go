// Package health provides the minimal loopback health surface shared by the
// host-side VM supervisor and the in-guest agent.
package health

import (
	"encoding/json"
	"net/http"
	"time"
)

type Response struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
	Now     string `json:"now"`
}

func NewHandler(service, version string) http.Handler {
	mux := http.NewServeMux()

	write := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(Response{
			Status:  "ok",
			Service: service,
			Version: version,
			Now:     time.Now().UTC().Format(time.RFC3339Nano),
		})
	}

	mux.HandleFunc("GET /healthz", write)
	mux.HandleFunc("GET /readyz", write)

	return mux
}
