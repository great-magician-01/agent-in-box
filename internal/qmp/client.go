// Package qmp implements the minimal QEMU Machine Protocol client used by the
// VM supervisor. It intentionally exposes fixed commands only; callers cannot
// pass model-generated command lines to the hypervisor.
package qmp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"
)

// Error is a QMP error response.
type Error struct {
	Class string `json:"class"`
	Desc  string `json:"desc"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("qmp %s: %s", e.Class, e.Desc)
}

type envelope struct {
	Return json.RawMessage `json:"return"`
	Data   json.RawMessage `json:"data"`
	Error  *Error          `json:"error"`
	Event  string          `json:"event"`
}

// Client serializes commands on one QMP connection.
type Client struct {
	conn   net.Conn
	reader *bufio.Reader
	writer *bufio.Writer
	mu     sync.Mutex
	events func(event string, data json.RawMessage)
}

// Dial connects to a loopback QMP endpoint and completes the capability handshake.
func Dial(ctx context.Context, address string, events func(event string, data json.RawMessage)) (*Client, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("dial qmp %s: %w", address, err)
	}

	client := &Client{
		conn:   conn,
		reader: bufio.NewReader(conn),
		writer: bufio.NewWriter(conn),
		events: events,
	}
	if err := client.handshake(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return client, nil
}

func (c *Client) handshake(ctx context.Context) error {
	if err := c.setDeadline(ctx); err != nil {
		return err
	}
	var greeting envelope
	if err := c.readEnvelope(&greeting); err != nil {
		return fmt.Errorf("read qmp greeting: %w", err)
	}
	var ignored json.RawMessage
	return c.execute(ctx, "qmp_capabilities", nil, &ignored)
}

func (c *Client) setDeadline(ctx context.Context) error {
	deadline := time.Now().Add(10 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	return c.conn.SetDeadline(deadline)
}

func (c *Client) readEnvelope(target *envelope) error {
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		return err
	}
	return json.Unmarshal(line, target)
}

// Execute runs one command and decodes its return value into out when out is non-nil.
func (c *Client) Execute(ctx context.Context, command string, arguments any, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.execute(ctx, command, arguments, out)
}

func (c *Client) execute(ctx context.Context, command string, arguments any, out any) error {
	if err := c.setDeadline(ctx); err != nil {
		return fmt.Errorf("set qmp deadline: %w", err)
	}

	request := map[string]any{"execute": command}
	if arguments != nil {
		request["arguments"] = arguments
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encode qmp command %s: %w", command, err)
	}
	if _, err := c.writer.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write qmp command %s: %w", command, err)
	}
	if err := c.writer.Flush(); err != nil {
		return fmt.Errorf("flush qmp command %s: %w", command, err)
	}

	for {
		var response envelope
		if err := c.readEnvelope(&response); err != nil {
			return fmt.Errorf("read qmp response for %s: %w", command, err)
		}
		if response.Event != "" {
			if c.events != nil {
				c.events(response.Event, response.Data)
			}
			continue
		}
		if response.Error != nil {
			return response.Error
		}
		if out != nil && len(response.Return) > 0 {
			if err := json.Unmarshal(response.Return, out); err != nil {
				return fmt.Errorf("decode qmp response for %s: %w", command, err)
			}
		}
		return nil
	}
}

// Close closes the QMP connection.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Close()
}

// Status is the result of query-status.
type Status struct {
	Status  string `json:"status"`
	Running bool   `json:"running"`
}

// QueryStatus reports the QEMU run state.
func (c *Client) QueryStatus(ctx context.Context) (Status, error) {
	var status Status
	err := c.Execute(ctx, "query-status", nil, &status)
	return status, err
}

// SystemPowerdown requests a guest ACPI shutdown.
func (c *Client) SystemPowerdown(ctx context.Context) error {
	return c.Execute(ctx, "system_powerdown", nil, nil)
}

// Quit terminates QEMU immediately and should only be used after a graceful timeout.
func (c *Client) Quit(ctx context.Context) error {
	return c.Execute(ctx, "quit", nil, nil)
}

// Screendump writes the current guest frame to a host path visible to QEMU.
func (c *Client) Screendump(ctx context.Context, filename string) error {
	return c.Execute(ctx, "screendump", map[string]any{"filename": filename}, nil)
}

// SendKey sends one QKeyCode chord, for example []string{"ctrl", "s"}.
func (c *Client) SendKey(ctx context.Context, keyCodes []string) error {
	keys := make([]map[string]string, 0, len(keyCodes))
	for _, code := range keyCodes {
		keys = append(keys, map[string]string{"type": "qcode", "data": code})
	}
	return c.Execute(ctx, "send-key", map[string]any{"keys": keys}, nil)
}

// InputEvent is one input-send-event item.
type InputEvent struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

// AbsolutePointerMove uses the normalized QMP absolute range 0..32767.
func AbsolutePointerMove(x, y int) []InputEvent {
	return []InputEvent{
		{Type: "abs", Data: map[string]any{"axis": "x", "value": x}},
		{Type: "abs", Data: map[string]any{"axis": "y", "value": y}},
	}
}

// PointerButton emits a button transition, for example button "left".
func PointerButton(button string, down bool) InputEvent {
	return InputEvent{Type: "btn", Data: map[string]any{"button": button, "down": down}}
}

// SendInput sends pointer or button events through the guest input device.
func (c *Client) SendInput(ctx context.Context, events []InputEvent) error {
	return c.Execute(ctx, "input-send-event", map[string]any{"events": events}, nil)
}
