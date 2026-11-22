package qmp

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type recordedCommand struct {
	Execute   string          `json:"execute"`
	Arguments json.RawMessage `json:"arguments"`
}

func startFakeServer(t *testing.T, handler func(command recordedCommand) []string) (string, *[]recordedCommand) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	var mu sync.Mutex
	commands := &[]recordedCommand{}
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		writer := bufio.NewWriter(conn)
		_, _ = writer.WriteString(`{"QMP":{"version":{"qemu":{"major":11,"minor":1,"micro":3}}}}` + "\n")
		_ = writer.Flush()
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var command recordedCommand
			if err := json.Unmarshal(line, &command); err != nil {
				return
			}
			mu.Lock()
			*commands = append(*commands, command)
			mu.Unlock()
			for _, response := range handler(command) {
				_, _ = writer.WriteString(response + "\n")
			}
			_ = writer.Flush()
		}
	}()
	return listener.Addr().String(), commands
}

func TestClientQueryUUID(t *testing.T) {
	address, _ := startFakeServer(t, func(command recordedCommand) []string {
		if command.Execute == "query-uuid" {
			return []string{`{"return":{"UUID":"8f1d6a52-2c4b-4e18-9b47-3a0e5c6d7f80"}}`}
		}
		return []string{`{"return":{}}`}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	uuid, err := client.QueryUUID(ctx)
	if err != nil {
		t.Fatalf("query uuid: %v", err)
	}
	if uuid != "8f1d6a52-2c4b-4e18-9b47-3a0e5c6d7f80" {
		t.Fatalf("uuid = %q", uuid)
	}
}

func TestDialUnixRequiresSocket(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	missing := filepath.Join(t.TempDir(), "missing.sock")
	if _, err := DialUnix(ctx, missing, nil); err == nil {
		t.Fatal("expected missing unix socket to fail")
	}
}

func TestDialTLSRejectsInsecureConfig(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// The config is rejected before any network access is attempted.
	if _, err := DialTLS(ctx, "127.0.0.1:1", &tls.Config{InsecureSkipVerify: true}, nil); err == nil {
		t.Fatal("expected InsecureSkipVerify to be rejected")
	}
	if _, err := DialTLS(ctx, "127.0.0.1:1", nil, nil); err == nil {
		t.Fatal("expected a nil tls.Config to be rejected")
	}
}

func TestClientHandshakeQueryAndEvents(t *testing.T) {
	address, commands := startFakeServer(t, func(command recordedCommand) []string {
		switch command.Execute {
		case "qmp_capabilities":
			return []string{`{"return":{}}`}
		case "query-status":
			return []string{
				`{"event":"RTC_CHANGE","data":{"offset":1}}`,
				`{"return":{"status":"running","running":true}}`,
			}
		default:
			return []string{`{"error":{"class":"GenericError","desc":"unexpected command"}}`}
		}
	})

	var events []string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, func(event string, _ json.RawMessage) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	status, err := client.QueryStatus(ctx)
	if err != nil {
		t.Fatalf("query status: %v", err)
	}
	if !status.Running || status.Status != "running" {
		t.Fatalf("unexpected status: %+v", status)
	}
	if len(events) != 1 || events[0] != "RTC_CHANGE" {
		t.Fatalf("expected RTC_CHANGE event, got %v", events)
	}
	if len(*commands) != 2 || (*commands)[0].Execute != "qmp_capabilities" || (*commands)[1].Execute != "query-status" {
		t.Fatalf("unexpected commands: %+v", *commands)
	}
}

func TestClientErrorResponse(t *testing.T) {
	address, _ := startFakeServer(t, func(command recordedCommand) []string {
		if command.Execute == "qmp_capabilities" {
			return []string{`{"return":{}}`}
		}
		return []string{`{"error":{"class":"CommandNotFound","desc":"bad command"}}`}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	err = client.Screendump(ctx, `C:\temp\shot.png`)
	if err == nil {
		t.Fatal("expected QMP error")
	}
	qmpError, ok := err.(*Error)
	if !ok || qmpError.Class != "CommandNotFound" {
		t.Fatalf("expected CommandNotFound error, got %T %v", err, err)
	}
}

func TestClientStopAndContUseFixedCommands(t *testing.T) {
	address, commands := startFakeServer(t, func(command recordedCommand) []string {
		return []string{`{"return":{}}`}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	if err := client.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if err := client.Cont(ctx); err != nil {
		t.Fatalf("cont: %v", err)
	}

	if len(*commands) != 3 {
		t.Fatalf("expected handshake + 2 commands, got %+v", *commands)
	}
	if (*commands)[1].Execute != "stop" || (*commands)[2].Execute != "cont" {
		t.Fatalf("unexpected commands: %+v", *commands)
	}
}

func TestClientInputEncoding(t *testing.T) {
	address, commands := startFakeServer(t, func(command recordedCommand) []string {
		return []string{`{"return":{}}`}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, address, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	events := AbsolutePointerMove(16383, 16383)
	events = append(events, PointerButton("left", true), PointerButton("left", false))
	if err := client.SendInput(ctx, events); err != nil {
		t.Fatalf("send input: %v", err)
	}
	if err := client.SendKey(ctx, []string{"ctrl", "s"}); err != nil {
		t.Fatalf("send key: %v", err)
	}

	if len(*commands) != 3 {
		t.Fatalf("expected handshake + 2 commands, got %d", len(*commands))
	}
	var inputArguments struct {
		Events []InputEvent `json:"events"`
	}
	if err := json.Unmarshal((*commands)[1].Arguments, &inputArguments); err != nil {
		t.Fatalf("decode input arguments: %v", err)
	}
	if len(inputArguments.Events) != 4 || inputArguments.Events[0].Data["value"] != float64(16383) {
		t.Fatalf("unexpected input events: %+v", inputArguments.Events)
	}
}
