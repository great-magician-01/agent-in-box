//go:build linux

package guestagent

import (
	"context"
	"fmt"
	"image"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/xgb"
	"github.com/BurntSushi/xgb/xproto"
	"github.com/BurntSushi/xgb/xtest"
)

type x11Desktop struct {
	conn     *xgb.Conn
	setup    *xproto.SetupInfo
	screen   *xproto.ScreenInfo
	keyboard *x11Keyboard
	mu       sync.Mutex
}

func newDesktop(display string) (Desktop, error) {
	return newX11Desktop(display)
}

func newX11Desktop(display string) (*x11Desktop, error) {
	conn, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, fmt.Errorf("connect X11 display %q: %w", display, err)
	}
	if err := xtest.Init(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("initialize XTEST: %w", err)
	}
	setup := xproto.Setup(conn)
	keyboard, err := newX11Keyboard(conn, setup)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &x11Desktop{
		conn:     conn,
		setup:    setup,
		screen:   setup.DefaultScreen(conn),
		keyboard: keyboard,
	}, nil
}

func (d *x11Desktop) Info(ctx context.Context) (DesktopInfo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.refreshGeometry(); err != nil {
		return DesktopInfo{}, err
	}
	return d.info(), nil
}

// refreshGeometry reads the current root window instead of relying on the X11
// setup block captured at connection time. XRandR changes therefore update both
// screenshots and input bounds without requiring an agent restart.
func (d *x11Desktop) refreshGeometry() error {
	geometry, err := xproto.GetGeometry(d.conn, xproto.Drawable(d.screen.Root)).Reply()
	if err != nil {
		return fmt.Errorf("read X11 root geometry: %w", err)
	}
	if geometry.Width == 0 || geometry.Height == 0 {
		return fmt.Errorf("X11 root geometry is empty")
	}
	d.screen.WidthInPixels = geometry.Width
	d.screen.HeightInPixels = geometry.Height
	return nil
}

func (d *x11Desktop) info() DesktopInfo {
	dpi := 96.0
	if d.screen.WidthInMillimeters > 0 {
		dpi = float64(d.screen.WidthInPixels) * 25.4 / float64(d.screen.WidthInMillimeters)
	}
	dpi = math.Round(dpi*10) / 10
	return DesktopInfo{
		DisplayServer: "x11",
		Width:         int(d.screen.WidthInPixels),
		Height:        int(d.screen.HeightInPixels),
		DPI:           dpi,
		ScaleFactor:   math.Round(dpi/96*1000) / 1000,
	}
}

func (d *x11Desktop) Screenshot(ctx context.Context) (image.Image, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.refreshGeometry(); err != nil {
		return nil, err
	}
	width := int(d.screen.WidthInPixels)
	height := int(d.screen.HeightInPixels)
	reply, err := xproto.GetImage(
		d.conn,
		xproto.ImageFormatZPixmap,
		xproto.Drawable(d.screen.Root),
		0,
		0,
		d.screen.WidthInPixels,
		d.screen.HeightInPixels,
		^uint32(0),
	).Reply()
	if err != nil {
		return nil, fmt.Errorf("X11 GetImage: %w", err)
	}

	bitsPerPixel := byte(0)
	for _, format := range d.setup.PixmapFormats {
		if format.Depth == d.screen.RootDepth {
			bitsPerPixel = format.BitsPerPixel
			break
		}
	}
	if bitsPerPixel != 32 {
		return nil, fmt.Errorf("unsupported X11 root depth %d with %d bits per pixel", d.screen.RootDepth, bitsPerPixel)
	}
	if len(reply.Data) < width*height*4 {
		return nil, fmt.Errorf("short X11 image: got %d bytes, need %d", len(reply.Data), width*height*4)
	}

	capture := image.NewRGBA(image.Rect(0, 0, width, height))
	littleEndian := d.setup.ImageByteOrder == 0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source := (y*width + x) * 4
			target := y*capture.Stride + x*4
			if littleEndian {
				capture.Pix[target+0] = reply.Data[source+2]
				capture.Pix[target+1] = reply.Data[source+1]
				capture.Pix[target+2] = reply.Data[source+0]
			} else {
				capture.Pix[target+0] = reply.Data[source+1]
				capture.Pix[target+1] = reply.Data[source+2]
				capture.Pix[target+2] = reply.Data[source+3]
			}
			capture.Pix[target+3] = 0xff
		}
	}
	return capture, nil
}

func (d *x11Desktop) Input(ctx context.Context, request InputRequest) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.refreshGeometry(); err != nil {
		return err
	}

	switch request.Type {
	case "move":
		point, err := d.point(request.Point)
		if err != nil {
			return err
		}
		d.move(point[0], point[1])
	case "click":
		point, err := d.point(request.Point)
		if err != nil {
			return err
		}
		button, err := mouseButton(request.Button)
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
		d.move(point[0], point[1])
		for index := 0; index < count; index++ {
			d.button(button, true)
			d.button(button, false)
			d.flush()
			if index+1 < count {
				time.Sleep(90 * time.Millisecond)
			}
		}
	case "scroll":
		if request.Point != nil {
			point, err := d.point(request.Point)
			if err != nil {
				return err
			}
			d.move(point[0], point[1])
		}
		d.scroll(request.DeltaX, request.DeltaY)
	case "keypress":
		if len(request.Keys) == 0 || len(request.Keys) > 8 {
			return fmt.Errorf("keypress requires 1..8 keys")
		}
		if err := d.keyboard.chord(request.Keys); err != nil {
			return err
		}
	case "type_text":
		if request.Text == "" || len(request.Text) > 20000 {
			return fmt.Errorf("type_text requires 1..20000 characters")
		}
		if err := d.keyboard.typeText(request.Text); err != nil {
			return err
		}
	case "drag":
		from, err := d.point(request.From)
		if err != nil {
			return err
		}
		to, err := d.point(request.To)
		if err != nil {
			return err
		}
		d.drag(from[0], from[1], to[0], to[1])
	case "wait":
		if request.Milliseconds < 0 || request.Milliseconds > 30000 {
			return fmt.Errorf("wait milliseconds must be 0..30000")
		}
		timer := time.NewTimer(time.Duration(request.Milliseconds) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	default:
		return fmt.Errorf("unsupported input action %q", request.Type)
	}
	d.flush()
	return nil
}

func (d *x11Desktop) point(point *Point) ([2]int, error) {
	if point == nil {
		return [2]int{}, fmt.Errorf("point is required")
	}
	x := int(math.Round(point.X))
	y := int(math.Round(point.Y))
	if x < 0 || y < 0 || x >= int(d.screen.WidthInPixels) || y >= int(d.screen.HeightInPixels) {
		return [2]int{}, fmt.Errorf("point (%d,%d) is outside %dx%d display", x, y, d.screen.WidthInPixels, d.screen.HeightInPixels)
	}
	return [2]int{x, y}, nil
}

func (d *x11Desktop) move(x, y int) {
	_ = xtest.FakeInput(d.conn, xproto.MotionNotify, 0, 0, d.screen.Root, int16(x), int16(y), 0)
}

func mouseButton(button string) (byte, error) {
	switch button {
	case "", "left":
		return 1, nil
	case "middle":
		return 2, nil
	case "right":
		return 3, nil
	default:
		return 0, fmt.Errorf("unsupported mouse button %q", button)
	}
}

func (d *x11Desktop) button(button byte, down bool) {
	event := byte(xproto.ButtonPress)
	if !down {
		event = xproto.ButtonRelease
	}
	_ = xtest.FakeInput(d.conn, event, button, 0, d.screen.Root, 0, 0, 0)
}

func (d *x11Desktop) scroll(deltaX, deltaY float64) {
	if deltaY != 0 {
		button := byte(5)
		if deltaY < 0 {
			button = 4
		}
		clicks := int(math.Min(20, math.Max(1, math.Abs(deltaY)/120)))
		for index := 0; index < clicks; index++ {
			d.button(button, true)
			d.button(button, false)
		}
	}
	if deltaX != 0 {
		button := byte(7)
		if deltaX < 0 {
			button = 6
		}
		clicks := int(math.Min(20, math.Max(1, math.Abs(deltaX)/120)))
		for index := 0; index < clicks; index++ {
			d.button(button, true)
			d.button(button, false)
		}
	}
}

func (d *x11Desktop) drag(fromX, fromY, toX, toY int) {
	d.move(fromX, fromY)
	d.button(1, true)
	for step := 1; step <= 12; step++ {
		x := fromX + (toX-fromX)*step/12
		y := fromY + (toY-fromY)*step/12
		d.move(x, y)
		d.flush()
		time.Sleep(15 * time.Millisecond)
	}
	d.button(1, false)
}

func (d *x11Desktop) flush() {
	d.conn.Sync()
}

func (d *x11Desktop) Close() error {
	d.conn.Close()
	return nil
}

type x11Binding struct {
	code  xproto.Keycode
	shift bool
}

type x11Keyboard struct {
	conn         *xgb.Conn
	perKeycode   int
	bindings     map[xproto.Keysym]x11Binding
	shift        xproto.Keycode
	spare        xproto.Keycode
	spareKeysyms []xproto.Keysym
}

func newX11Keyboard(conn *xgb.Conn, setup *xproto.SetupInfo) (*x11Keyboard, error) {
	minimum := setup.MinKeycode
	maximum := setup.MaxKeycode
	count := byte(maximum - minimum + 1)
	reply, err := xproto.GetKeyboardMapping(conn, minimum, count).Reply()
	if err != nil {
		return nil, fmt.Errorf("get X11 keyboard mapping: %w", err)
	}
	keyboard := &x11Keyboard{
		conn:       conn,
		perKeycode: int(reply.KeysymsPerKeycode),
		bindings:   map[xproto.Keysym]x11Binding{},
	}
	if keyboard.perKeycode == 0 {
		return nil, fmt.Errorf("X11 returned zero keysyms per keycode")
	}

	for index := 0; index < int(count); index++ {
		code := minimum + xproto.Keycode(index)
		syms := reply.Keysyms[index*keyboard.perKeycode : (index+1)*keyboard.perKeycode]
		empty := true
		for slot, sym := range syms {
			if sym == 0 {
				continue
			}
			empty = false
			if slot <= 1 {
				if _, exists := keyboard.bindings[sym]; !exists {
					keyboard.bindings[sym] = x11Binding{code: code, shift: slot == 1}
				}
			}
		}
		if empty && keyboard.spare == 0 {
			keyboard.spare = code
			keyboard.spareKeysyms = append([]xproto.Keysym(nil), syms...)
		}
	}
	if keyboard.spare == 0 {
		keyboard.spare = maximum
		start := (int(count) - 1) * keyboard.perKeycode
		keyboard.spareKeysyms = append([]xproto.Keysym(nil), reply.Keysyms[start:start+keyboard.perKeycode]...)
	}
	if binding, ok := keyboard.bindings[0xffe1]; ok {
		keyboard.shift = binding.code
	}
	return keyboard, nil
}

var namedKeysyms = map[string]xproto.Keysym{
	"ctrl": 0xffe3, "control": 0xffe3, "shift": 0xffe1,
	"alt": 0xffe9, "meta": 0xffe7, "super": 0xffeb, "win": 0xffeb,
	"enter": 0xff0d, "return": 0xff0d, "esc": 0xff1b, "escape": 0xff1b,
	"backspace": 0xff08, "tab": 0xff09, "space": 0x20,
	"up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53,
	"delete": 0xffff, "home": 0xff50, "end": 0xff57,
	"pageup": 0xff55, "pagedown": 0xff56,
}

func unicodeKeysym(r rune) (xproto.Keysym, error) {
	if r < 0 || r > 0x10ffff {
		return 0, fmt.Errorf("invalid Unicode code point %d", r)
	}
	if r <= 0xff {
		return xproto.Keysym(r), nil
	}
	return xproto.Keysym(0x01000000 | uint32(r)), nil
}

func (k *x11Keyboard) bindingForKeysym(sym xproto.Keysym) (x11Binding, bool, error) {
	if binding, ok := k.bindings[sym]; ok {
		return binding, false, nil
	}
	// Same approach as xdotool: temporarily map an unused keycode to the
	// requested Unicode keysym, then restore it after the synthetic key event.
	syms := make([]xproto.Keysym, k.perKeycode)
	syms[0] = sym
	if k.perKeycode > 1 {
		syms[1] = sym
	}
	xproto.ChangeKeyboardMapping(k.conn, 1, k.spare, byte(k.perKeycode), syms)
	k.conn.Sync()
	readback, err := xproto.GetKeyboardMapping(k.conn, k.spare, 1).Reply()
	if err != nil {
		return x11Binding{}, false, fmt.Errorf("read back Unicode keymap: %w", err)
	}
	if len(readback.Keysyms) == 0 || readback.Keysyms[0] != sym {
		return x11Binding{}, false, fmt.Errorf("Unicode keymap did not take effect at keycode %d", k.spare)
	}
	return x11Binding{code: k.spare}, true, nil
}

func (k *x11Keyboard) restoreSpare() {
	xproto.ChangeKeyboardMapping(k.conn, 1, k.spare, byte(k.perKeycode), k.spareKeysyms)
	k.conn.Sync()
}

func (k *x11Keyboard) keyEvent(code xproto.Keycode, down bool) {
	event := byte(xproto.KeyPress)
	if !down {
		event = xproto.KeyRelease
	}
	_ = xtest.FakeInput(k.conn, event, byte(code), 0, 0, 0, 0, 0)
}

func (k *x11Keyboard) press(binding x11Binding) {
	if binding.shift && k.shift != 0 {
		k.keyEvent(k.shift, true)
	}
	k.keyEvent(binding.code, true)
}

func (k *x11Keyboard) release(binding x11Binding) {
	k.keyEvent(binding.code, false)
	if binding.shift && k.shift != 0 {
		k.keyEvent(k.shift, false)
	}
}

func (k *x11Keyboard) typeText(text string) error {
	temporaryUsed := false
	defer func() {
		if temporaryUsed {
			// X clients resolve keycodes to keysyms when they process the event,
			// not when XTEST queues it. Restoring immediately after each rune made
			// non-ASCII characters appear as '?'. Keep the temporary mapping until
			// the whole text has been delivered and the server has caught up.
			k.conn.Sync()
			time.Sleep(100 * time.Millisecond)
			k.restoreSpare()
		}
	}()
	for _, r := range text {
		if r == '\n' {
			if err := k.chord([]string{"enter"}); err != nil {
				return err
			}
			continue
		}
		sym, err := unicodeKeysym(r)
		if err != nil {
			return err
		}
		binding, temporary, err := k.bindingForKeysym(sym)
		if err != nil {
			return err
		}
		temporaryUsed = temporaryUsed || temporary
		k.press(binding)
		k.release(binding)
		k.conn.Sync()
		if temporary {
			// The spare keycode is reused for the next unmapped rune. Give X
			// clients a processing window before changing its keysym again,
			// otherwise consecutive CJK characters collapse to the last one.
			time.Sleep(75 * time.Millisecond)
		}
	}
	return nil
}

func (k *x11Keyboard) chord(keys []string) error {
	bindings := make([]x11Binding, 0, len(keys))
	for _, key := range keys {
		normalized := strings.ToLower(strings.TrimSpace(key))
		var sym xproto.Keysym
		if named, ok := namedKeysyms[normalized]; ok {
			sym = named
		} else {
			runes := []rune(normalized)
			if len(runes) != 1 {
				return fmt.Errorf("unknown key name %q", key)
			}
			value, err := unicodeKeysym(runes[0])
			if err != nil {
				return err
			}
			sym = value
		}
		binding, temporary, err := k.bindingForKeysym(sym)
		if err != nil {
			return err
		}
		if temporary {
			k.restoreSpare()
			return fmt.Errorf("key %q requires temporary mapping and is not supported in chords", key)
		}
		bindings = append(bindings, binding)
	}
	for _, binding := range bindings {
		k.press(binding)
	}
	for index := len(bindings) - 1; index >= 0; index-- {
		k.release(bindings[index])
	}
	k.conn.Sync()
	return nil
}
