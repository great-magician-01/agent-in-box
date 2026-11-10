package vmsupervisor

import (
	"context"
	"errors"
	"net/http"

	"agent-in-box/internal/vmprovider"
)

const (
	codeNotFound         = "not_found"
	codeConflict         = "conflict"
	codeInvalidSpec      = "invalid_spec"
	codeInvalidRequest   = "invalid_request"
	codeUnavailable      = "unavailable"
	codeInternal         = "internal"
	codeUnauthorized     = "unauthorized"
	codeMethodNotAllowed = "method_not_allowed"
)

type apiErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type apiErrorResponse struct {
	OK    bool         `json:"ok"`
	Error apiErrorBody `json:"error"`
}

// requestError is a client-visible HTTP error produced while decoding a
// request. Provider errors are classified separately.
type requestError struct {
	status  int
	code    string
	message string
}

func (e *requestError) Error() string {
	return e.message
}

func newRequestError(status int, code, message string) error {
	return &requestError{status: status, code: code, message: message}
}

func invalidRequest(message string) error {
	return newRequestError(http.StatusBadRequest, codeInvalidRequest, message)
}

func classifyError(err error) (status int, code, message string) {
	var requestErr *requestError
	if errors.As(err, &requestErr) {
		return requestErr.status, requestErr.code, requestErr.message
	}

	switch {
	case errors.Is(err, vmprovider.ErrNotFound):
		return http.StatusNotFound, codeNotFound, err.Error()
	case errors.Is(err, vmprovider.ErrAlreadyExists),
		errors.Is(err, vmprovider.ErrNotStopped),
		errors.Is(err, vmprovider.ErrNotRunning):
		return http.StatusConflict, codeConflict, err.Error()
	case errors.Is(err, vmprovider.ErrInvalidSpec):
		return http.StatusBadRequest, codeInvalidSpec, err.Error()
	case errors.Is(err, vmprovider.ErrQmpUnavailable):
		return http.StatusServiceUnavailable, codeUnavailable, err.Error()
	case errors.Is(err, vmprovider.ErrUnsupported):
		return http.StatusServiceUnavailable, codeUnavailable, err.Error()
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusServiceUnavailable, codeUnavailable, "operation timed out"
	case errors.Is(err, context.Canceled):
		return http.StatusServiceUnavailable, codeUnavailable, "operation canceled"
	default:
		return http.StatusInternalServerError, codeInternal, "internal error"
	}
}
