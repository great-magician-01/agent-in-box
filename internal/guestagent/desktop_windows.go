//go:build windows

package guestagent

import (
	"context"
	"errors"
	"fmt"
	"image"
	"math"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

// Windows session boundaries are explicit: the agent never tries to capture or
// inject input on the lock screen or a UAC secure desktop. Those states require
// the user to take over through the console.
var errWindowsDesktop = errors.New("Windows desktop is unavailable")

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")

	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
	procGetSystemMetrics              = user32.NewProc("GetSystemMetrics")
	procGetDC                         = user32.NewProc("GetDC")
	procReleaseDC                     = user32.NewProc("ReleaseDC")
	procGetDpiForSystem               = user32.NewProc("GetDpiForSystem")
	procOpenInputDesktop              = user32.NewProc("OpenInputDesktop")
	procCloseDesktop                  = user32.NewProc("CloseDesktop")
	procGetUserObjectInformationW     = user32.NewProc("GetUserObjectInformationW")
	procSetCursorPos                  = user32.NewProc("SetCursorPos")
	procSendInput                     = user32.NewProc("SendInput")
	procVkKeyScanW                    = user32.NewProc("VkKeyScanW")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
)

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualSrceen = 78
	smCyVirtualScreen = 79

	srcCopy       = 0x00CC0020
	dibRGBColors  = 0
	biRGB         = 0
	inputMouse    = 0
	inputKeyboard = 1

	mouseMove       = 0x0001
	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800
	mouseHWheel     = 0x1000

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyUnicode  = 0x0004

	desktopReadObjects     = 0x0001
	userObjectName         = 2
	maxVirtualScreenPixels = 16384
)

type windowsDesktop struct {
	mu sync.Mutex
}

type windowsInput struct {
	typ uint32
	_   uint32
	// union is the INPUT union. MOUSEINPUT is the largest member (32 bytes on
	// 64-bit Windows). Product builds target Windows amd64/arm64 only.
	union [4]uintptr
}

type windowsMouseInput struct {
	dx        int32
	dy        int32
	mouseData uint32
	flags     uint32
	time      uint32
	extraInfo uintptr
}

type windowsKeyboardInput struct {
	vk        uint16
	scan      uint16
	flags     uint32
	time      uint32
	extraInfo uintptr
}

type bitmapInfoHeader struct {
	size          uint32
	width         int32
	height        int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPelsPerMeter int32
	yPelsPerMeter int32
	clrUsed       uint32
	clrImportant  uint32
}

type bitmapInfo struct {
	header bitmapInfoHeader
	colors [1]uint32
}

func newDesktop(display string) (Desktop, error) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return nil, fmt.Errorf("Windows guest desktop requires a 64-bit build (got %s)", runtime.GOARCH)
	}
	d := &windowsDesktop{}
	d.enableDpiAwareness()
	if _, _, _, _, err := screenMetrics(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *windowsDesktop) enableDpiAwareness() {
	// PROCESS_PER_MONITOR_DPI_AWARE_V2 = -4. SetProcessDpiAwarenessContext is
	// unavailable before Windows 10 1607; fall back to system DPI awareness.
	const perMonitorAwareV2 = ^uintptr(3)
	if procSetProcessDpiAwarenessContext.Find() == nil {
		procSetProcessDpiAwarenessContext.Call(perMonitorAwareV2)
		return
	}
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}
}

func screenMetrics() (vx, vy, width, height int, err error) {
	vx = int(int32(callInt(procGetSystemMetrics, smXVirtualScreen)))
	vy = int(int32(callInt(procGetSystemMetrics, smYVirtualScreen)))
	width = int(int32(callInt(procGetSystemMetrics, smCxVirtualSrceen)))
	height = int(int32(callInt(procGetSystemMetrics, smCyVirtualScreen)))
	if width <= 0 || height <= 0 {
		return 0, 0, 0, 0, fmt.Errorf("%w: display metrics are %dx%d", errWindowsDesktop, width, height)
	}
	if width > maxVirtualScreenPixels || height > maxVirtualScreenPixels {
		return 0, 0, 0, 0, fmt.Errorf("%w: virtual screen %dx%d is too large", errWindowsDesktop, width, height)
	}
	return vx, vy, width, height, nil
}

func callInt(proc *syscall.LazyProc, value int) uintptr {
	result, _, _ := proc.Call(uintptr(value))
	return result
}

func systemDpi() float64 {
	if procGetDpiForSystem.Find() == nil {
		if dpi := callInt(procGetDpiForSystem, 0); dpi >= 48 && dpi <= 960 {
			return float64(dpi)
		}
	}
	dc, _, _ := procGetDC.Call(0)
	if dc == 0 {
		return 96
	}
	defer procReleaseDC.Call(0, dc)
	dpi, _, _ := gdi32.NewProc("GetDeviceCaps").Call(dc, 88) // LOGPIXELSX
	if dpi >= 48 && dpi <= 960 {
		return float64(dpi)
	}
	return 96
}

// sessionState distinguishes the ordinary desktop from the lock screen and UAC
// secure desktop. Both non-default desktops are reported to the host so a task
// blocks for human takeover instead of retrying blindly.
func sessionState() string {
	desktop, _, _ := procOpenInputDesktop.Call(0, 0, desktopReadObjects)
	if desktop == 0 {
		return "locked"
	}
	defer procCloseDesktop.Call(desktop)
	name := desktopName(desktop)
	if name == "" {
		return "locked"
	}
	if !strings.EqualFold(name, "Default") {
		return "secure_desktop"
	}
	return "interactive"
}

func desktopName(desktop uintptr) string {
	buffer := make([]uint16, 256)
	needed := uint32(0)
	ok, _, _ := procGetUserObjectInformationW.Call(
		desktop,
		userObjectName,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)*2),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ok == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

func (d *windowsDesktop) Info(ctx context.Context) (DesktopInfo, error) {
	if err := ctx.Err(); err != nil {
		return DesktopInfo{}, err
	}
	_, _, width, height, err := screenMetrics()
	if err != nil {
		return DesktopInfo{}, err
	}
	dpi := systemDpi()
	state := sessionState()
	return DesktopInfo{
		DisplayServer: "windows",
		Width:         width,
		Height:        height,
		DPI:           math.Round(dpi*10) / 10,
		ScaleFactor:   math.Round(dpi/96*1000) / 1000,
		SessionState:  state,
		Locked:        state == "locked",
		SecureDesktop: state == "secure_desktop",
	}, nil
}

func (d *windowsDesktop) requireInteractive() error {
	switch sessionState() {
	case "interactive":
		return nil
	case "locked":
		return ErrSessionLocked
	default:
		return ErrSecureDesktop
	}
}

func (d *windowsDesktop) Screenshot(ctx context.Context) (image.Image, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := d.requireInteractive(); err != nil {
		return nil, err
	}
	vx, vy, width, height, err := screenMetrics()
	if err != nil {
		return nil, err
	}
	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return nil, fmt.Errorf("%w: GetDC failed", errWindowsDesktop)
	}
	defer procReleaseDC.Call(0, screenDC)

	memoryDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	if memoryDC == 0 {
		return nil, fmt.Errorf("%w: CreateCompatibleDC failed", errWindowsDesktop)
	}
	defer procDeleteDC.Call(memoryDC)

	bitmap, _, _ := procCreateCompatibleBitmap.Call(screenDC, uintptr(width), uintptr(height))
	if bitmap == 0 {
		return nil, fmt.Errorf("%w: CreateCompatibleBitmap failed", errWindowsDesktop)
	}
	defer procDeleteObject.Call(bitmap)

	old, _, _ := procSelectObject.Call(memoryDC, bitmap)
	if old == 0 {
		return nil, fmt.Errorf("%w: SelectObject failed", errWindowsDesktop)
	}
	copied, _, _ := procBitBlt.Call(
		memoryDC, 0, 0, uintptr(width), uintptr(height), screenDC,
		uintptr(int32(vx)), uintptr(int32(vy)), srcCopy,
	)
	procSelectObject.Call(memoryDC, old)
	if copied == 0 {
		return nil, fmt.Errorf("%w: BitBlt failed", errWindowsDesktop)
	}

	bits := make([]byte, width*height*4)
	bmi := bitmapInfo{}
	bmi.header.size = uint32(unsafe.Sizeof(bmi.header))
	bmi.header.width = int32(width)
	bmi.header.height = -int32(height) // top-down rows
	bmi.header.planes = 1
	bmi.header.bitCount = 32
	bmi.header.compression = biRGB
	rows, _, _ := procGetDIBits.Call(
		screenDC, bitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&bits[0])),
		uintptr(unsafe.Pointer(&bmi)), dibRGBColors,
	)
	if rows == 0 {
		return nil, fmt.Errorf("%w: GetDIBits failed", errWindowsDesktop)
	}

	capture := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		sourceRow := bits[y*width*4:]
		targetRow := capture.Pix[y*capture.Stride:]
		for x := 0; x < width; x++ {
			source := sourceRow[x*4:]
			target := targetRow[x*4:]
			target[0] = source[2]
			target[1] = source[1]
			target[2] = source[0]
			target[3] = 0xff
		}
	}
	return capture, nil
}

func (d *windowsDesktop) Input(ctx context.Context, request InputRequest) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := d.requireInteractive(); err != nil {
		return err
	}
	vx, vy, width, height, err := screenMetrics()
	if err != nil {
		return err
	}

	switch request.Type {
	case "move":
		x, y, err := windowsPoint(request.Point, vx, vy, width, height)
		if err != nil {
			return err
		}
		return setCursorPosition(x, y)
	case "click":
		x, y, err := windowsPoint(request.Point, vx, vy, width, height)
		if err != nil {
			return err
		}
		down, up, err := windowsMouseButton(request.Button)
		if err != nil {
			return err
		}
		count := request.Count
		if count == 0 {
			count = 1
		}
		if count < 1 || count > 2 {
			return fmt.Errorf("click count must be 1 or 2")
		}
		if err := setCursorPosition(x, y); err != nil {
			return err
		}
		for index := 0; index < count; index++ {
			if err := sendMouseInput(0, 0, 0, down); err != nil {
				return err
			}
			if err := sendMouseInput(0, 0, 0, up); err != nil {
				return err
			}
			if index+1 < count {
				if err := sleepContext(ctx, 90*time.Millisecond); err != nil {
					return err
				}
			}
		}
		return nil
	case "scroll":
		if request.Point != nil {
			x, y, err := windowsPoint(request.Point, vx, vy, width, height)
			if err != nil {
				return err
			}
			if err := setCursorPosition(x, y); err != nil {
				return err
			}
		}
		return windowsScroll(ctx, request.DeltaX, request.DeltaY)
	case "keypress":
		if len(request.Keys) == 0 || len(request.Keys) > 8 {
			return fmt.Errorf("keypress requires 1..8 keys")
		}
		plan, err := windowsChordPlan(request.Keys)
		if err != nil {
			return err
		}
		for _, key := range plan {
			if err := sendKeyboardInput(key.vk, 0, key.flags); err != nil {
				return err
			}
		}
		for index := len(plan) - 1; index >= 0; index-- {
			key := plan[index]
			if err := sendKeyboardInput(key.vk, 0, key.flags|keyUp); err != nil {
				return err
			}
		}
		return nil
	case "type_text":
		if request.Text == "" || utf8.RuneCountInString(request.Text) > 20000 {
			return fmt.Errorf("type_text requires 1..20000 characters")
		}
		return windowsTypeText(ctx, request.Text)
	case "drag":
		fromX, fromY, err := windowsPoint(request.From, vx, vy, width, height)
		if err != nil {
			return err
		}
		toX, toY, err := windowsPoint(request.To, vx, vy, width, height)
		if err != nil {
			return err
		}
		if err := setCursorPosition(fromX, fromY); err != nil {
			return err
		}
		if err := sendMouseInput(0, 0, 0, mouseLeftDown); err != nil {
			return err
		}
		released := false
		defer func() {
			if !released {
				_ = sendMouseInput(0, 0, 0, mouseLeftUp)
			}
		}()
		for step := 1; step <= 12; step++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			x := fromX + (toX-fromX)*step/12
			y := fromY + (toY-fromY)*step/12
			if err := setCursorPosition(x, y); err != nil {
				return err
			}
			if err := sleepContext(ctx, 15*time.Millisecond); err != nil {
				return err
			}
		}
		if err := sendMouseInput(0, 0, 0, mouseLeftUp); err != nil {
			return err
		}
		released = true
		return nil
	case "wait":
		if request.Milliseconds < 0 || request.Milliseconds > 30000 {
			return fmt.Errorf("wait milliseconds must be 0..30000")
		}
		return sleepContext(ctx, time.Duration(request.Milliseconds)*time.Millisecond)
	default:
		return fmt.Errorf("unsupported input action %q", request.Type)
	}
}

func windowsPoint(point *Point, vx, vy, width, height int) (int, int, error) {
	if point == nil {
		return 0, 0, fmt.Errorf("point is required")
	}
	x := int(math.Round(point.X))
	y := int(math.Round(point.Y))
	if x < 0 || y < 0 || x >= width || y >= height {
		return 0, 0, fmt.Errorf("point (%d,%d) is outside %dx%d display", x, y, width, height)
	}
	return vx + x, vy + y, nil
}

func windowsMouseButton(button string) (uint32, uint32, error) {
	switch button {
	case "", "left":
		return mouseLeftDown, mouseLeftUp, nil
	case "middle":
		return mouseMiddleDown, mouseMiddleUp, nil
	case "right":
		return mouseRightDown, mouseRightUp, nil
	default:
		return 0, 0, fmt.Errorf("unsupported mouse button %q", button)
	}
}

func windowsScroll(ctx context.Context, deltaX, deltaY float64) error {
	var negativeWheel int32 = -120
	if deltaY != 0 {
		clicks := wheelClicks(deltaY)
		delta := uint32(120)
		if deltaY > 0 {
			// Positive protocol deltaY scrolls down; Windows wheel positive is up.
			delta = uint32(negativeWheel)
		}
		for index := 0; index < clicks; index++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := sendMouseInput(0, 0, delta, mouseWheel); err != nil {
				return err
			}
		}
	}
	if deltaX != 0 {
		clicks := wheelClicks(deltaX)
		delta := uint32(120)
		if deltaX < 0 {
			delta = uint32(negativeWheel)
		}
		for index := 0; index < clicks; index++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := sendMouseInput(0, 0, delta, mouseHWheel); err != nil {
				return err
			}
		}
	}
	return nil
}

func wheelClicks(delta float64) int {
	return int(math.Min(20, math.Max(1, math.Abs(delta)/120)))
}

func setCursorPosition(x, y int) error {
	ok, _, err := procSetCursorPos.Call(uintptr(x), uintptr(y))
	if ok == 0 {
		if err != syscall.Errno(0) {
			return fmt.Errorf("SetCursorPos failed: %w", err)
		}
		return errors.New("SetCursorPos failed")
	}
	return nil
}

func sendMouseInput(dx, dy int32, data uint32, flags uint32) error {
	input := windowsInput{typ: inputMouse}
	*(*windowsMouseInput)(unsafe.Pointer(&input.union)) = windowsMouseInput{
		dx: dx, dy: dy, mouseData: data, flags: flags,
	}
	return sendInputs(&input)
}

func sendKeyboardInput(vk, scan uint16, flags uint32) error {
	input := windowsInput{typ: inputKeyboard}
	*(*windowsKeyboardInput)(unsafe.Pointer(&input.union)) = windowsKeyboardInput{
		vk: vk, scan: scan, flags: flags,
	}
	return sendInputs(&input)
}

func sendInputs(input *windowsInput) error {
	sent, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(input)), unsafe.Sizeof(*input))
	if sent != 1 {
		if errno, ok := err.(syscall.Errno); ok && errno != 0 {
			return fmt.Errorf("SendInput failed: %w", errno)
		}
		return errors.New("SendInput failed")
	}
	return nil
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type windowsKey struct {
	vk    uint16
	flags uint32
}

var windowsNamedKeys = map[string]uint16{
	"ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12,
	"meta": 0x5B, "win": 0x5B, "super": 0x5B,
	"enter": 0x0D, "return": 0x0D, "esc": 0x1B, "escape": 0x1B,
	"backspace": 0x08, "tab": 0x09, "space": 0x20,
	"up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
	"delete": 0x2E, "del": 0x2E, "insert": 0x2D,
	"home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
	"f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
	"f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
	"f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

var windowsExtendedKeys = map[uint16]bool{
	0x26: true, 0x28: true, 0x25: true, 0x27: true,
	0x2E: true, 0x2D: true, 0x24: true, 0x23: true,
	0x21: true, 0x22: true,
}

func windowsChordPlan(keys []string) ([]windowsKey, error) {
	plan := make([]windowsKey, 0, len(keys)+1)
	hasShift := false
	for _, key := range keys {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "shift" {
			hasShift = true
		}
	}
	for _, key := range keys {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if vk, ok := windowsNamedKeys[normalized]; ok {
			plan = append(plan, windowsKey{vk: vk, flags: windowsKeyFlags(vk)})
			continue
		}
		runes := []rune(normalized)
		if len(runes) != 1 || runes[0] > 0xFFFF {
			return nil, fmt.Errorf("unknown key name %q", key)
		}
		vk, shift, ok := windowsVirtualKey(runes[0])
		if !ok {
			return nil, fmt.Errorf("key %q has no Windows virtual-key mapping", key)
		}
		if shift && !hasShift {
			plan = append(plan, windowsKey{vk: 0x10})
			hasShift = true
		}
		plan = append(plan, windowsKey{vk: vk, flags: windowsKeyFlags(vk)})
	}
	return plan, nil
}

func windowsVirtualKey(r rune) (uint16, bool, bool) {
	result, _, _ := procVkKeyScanW.Call(uintptr(r))
	value := int16(uint16(result))
	if value == -1 {
		return 0, false, false
	}
	vk := uint16(value & 0xff)
	state := byte(uint16(value) >> 8)
	return vk, state&1 != 0, true
}

func windowsKeyFlags(vk uint16) uint32 {
	if windowsExtendedKeys[vk] {
		return keyExtended
	}
	return 0
}

func windowsTypeText(ctx context.Context, text string) error {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	units := utf16.Encode([]rune(text))
	for index := 0; index < len(units); index++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		unit := units[index]
		if unit == '\n' {
			if err := sendKeyboardInput(0x0D, 0, 0); err != nil {
				return err
			}
			if err := sendKeyboardInput(0x0D, 0, keyUp); err != nil {
				return err
			}
			continue
		}
		if err := sendKeyboardInput(0, unit, keyUnicode); err != nil {
			return err
		}
		if err := sendKeyboardInput(0, unit, keyUnicode|keyUp); err != nil {
			return err
		}
	}
	return nil
}

func (d *windowsDesktop) Close() error {
	return nil
}
