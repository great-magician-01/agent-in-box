package guestagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client is the host-side counterpart of the guest RPC server. The token should
// be a short-lived, VM-scoped credential issued by the control plane.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewClient(baseURL string, token string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		token:      token,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// RPCError preserves the HTTP status and guest error code.
type RPCError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("guest rpc %d %s: %s", e.StatusCode, e.Code, e.Message)
}

func (c *Client) newRequest(ctx context.Context, method string, path string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	return request, nil
}

func decodeRPCError(response *http.Response) error {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.NewDecoder(response.Body).Decode(&payload)
	if payload.Error.Message == "" {
		payload.Error.Message = response.Status
	}
	return &RPCError{StatusCode: response.StatusCode, Code: payload.Error.Code, Message: payload.Error.Message}
}

func (c *Client) doJSON(ctx context.Context, method string, path string, input any, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeRPCError(response)
	}
	if output != nil {
		return json.NewDecoder(response.Body).Decode(output)
	}
	return nil
}

func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	var result Capabilities
	err := c.doJSON(ctx, http.MethodGet, "/v1/capabilities", nil, &result)
	return result, err
}

func (c *Client) DesktopInfo(ctx context.Context) (DesktopInfo, error) {
	var result DesktopInfo
	err := c.doJSON(ctx, http.MethodGet, "/v1/desktop", nil, &result)
	return result, err
}

func (c *Client) Input(ctx context.Context, request InputRequest) (ActionResult, error) {
	var result ActionResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/input", request, &result)
	return result, err
}

// ScreenshotMetadata accompanies the decoded PNG frame.
type ScreenshotMetadata struct {
	ActionID string
	Width    int
	Height   int
}

func (c *Client) Screenshot(ctx context.Context) (image.Image, ScreenshotMetadata, error) {
	request, err := c.newRequest(ctx, http.MethodGet, "/v1/screenshot", nil)
	if err != nil {
		return nil, ScreenshotMetadata{}, err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, ScreenshotMetadata{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, ScreenshotMetadata{}, decodeRPCError(response)
	}
	capture, err := png.Decode(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return nil, ScreenshotMetadata{}, fmt.Errorf("decode guest screenshot: %w", err)
	}
	width, _ := strconv.Atoi(response.Header.Get("X-Agent-In-Box-Width"))
	height, _ := strconv.Atoi(response.Header.Get("X-Agent-In-Box-Height"))
	return capture, ScreenshotMetadata{
		ActionID: response.Header.Get("X-Agent-In-Box-Action-Id"),
		Width:    width,
		Height:   height,
	}, nil
}
