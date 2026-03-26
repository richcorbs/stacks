/// Speech indicator — push-to-talk UI and speech recognition integration.
///
/// Hold shift (alone, no other keys) for 1 second to start recording.
/// Release shift to stop recording after a 1-second tail delay.
/// Transcribed text is sent to the focused terminal's PTY.
const std = @import("std");
const objc = @import("../objc.zig");
const speech = @import("../speech.zig");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const Phase = enum {
    idle,
    pending, // shift held, waiting for 1-second activation delay
    recording, // actively recording speech
    tail, // shift released, 1-second tail before stop
};

var phase: Phase = .idle;
var active_view: ?objc.id = null;
var last_transcription: [4096]u8 = undefined;
var last_transcription_len: usize = 0;

// Timers
var activation_timer: ?objc.id = null;
var tail_timer: ?objc.id = null;

// UI elements
var indicator_view: ?objc.id = null;
var wave_timer: ?objc.id = null;
var wave_phase: u8 = 0;
var wave_bars: [5]?objc.id = .{ null, null, null, null, null };

// ObjC helper class
var timer_helper_class: ?objc.id = null;

// Callback to write text to the focused terminal
var write_callback: ?*const fn ([]const u8) void = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Register ObjC helper class. Call once during setup.
pub fn init() void {
    if (timer_helper_class != null) return;
    const NSObject = objc.getClass("NSObject") orelse return;
    timer_helper_class = objc.allocateClassPair(NSObject, "SpeechIndicatorHelper");
    if (timer_helper_class) |cls| {
        _ = objc.addMethod(cls, objc.sel("activationFired:"), &activationFired, "v@:@");
        _ = objc.addMethod(cls, objc.sel("tailFired:"), &tailFired, "v@:@");
        _ = objc.addMethod(cls, objc.sel("waveFired:"), &waveFired, "v@:@");
        objc.registerClassPair(cls);
    }
}

/// Cancel any active speech session. Call when terminal loses focus,
/// a dialog opens, or any other event that should abort recording.
pub fn cancel() void {
    if (phase == .idle) return;
    cancelTimer(&activation_timer);
    cancelTimer(&tail_timer);
    if (phase == .recording or phase == .tail) {
        speech.stopListening();
        hideIndicator();
    }
    phase = .idle;
    write_callback = null;
}

/// Handle a flagsChanged event from the terminal view.
pub fn handleFlagsChanged(view: objc.id, event: objc.id, writeFn: *const fn ([]const u8) void) void {
    // Only activate when the terminal view is the first responder
    if (!isFirstResponder(view)) {
        if (phase != .idle) cancel();
        return;
    }

    const modifierFlags: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSUInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const flags = modifierFlags(event, objc.sel("modifierFlags"));

    // Mask to just the modifier bits we care about (ignore device-dependent bits)
    const modifier_mask: objc.NSUInteger = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);
    const relevant = flags & modifier_mask;
    const shift_only = relevant == (1 << 17); // EXACTLY shift and nothing else

    switch (phase) {
        .idle => {
            if (shift_only) {
                phase = .pending;
                active_view = view;
                write_callback = writeFn;
                activation_timer = scheduleTimer("activationFired:", 1.0, false);
            }
        },
        .pending => {
            if (!shift_only) {
                // Any change away from shift-only cancels
                cancelTimer(&activation_timer);
                phase = .idle;
            }
        },
        .recording => {
            if (!shift_only) {
                // Shift released or other modifier added — start tail delay
                phase = .tail;
                tail_timer = scheduleTimer("tailFired:", 1.0, false);
            }
        },
        .tail => {
            if (shift_only) {
                // Shift pressed again during tail — resume recording
                cancelTimer(&tail_timer);
                phase = .recording;
            }
            // Other modifier changes during tail are ignored — timer will fire
        },
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn isFirstResponder(view: objc.id) bool {
    const win = objc.msgSend(view, objc.sel("window"));
    if (@intFromPtr(win) == 0) return false;
    const first = objc.msgSend(win, objc.sel("firstResponder"));
    return first == view;
}

// ---------------------------------------------------------------------------
// Timer callbacks
// ---------------------------------------------------------------------------

fn activationFired(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    activation_timer = null;
    if (phase != .pending) return;

    // Double-check: is the view still first responder?
    if (active_view) |view| {
        if (!isFirstResponder(view)) {
            phase = .idle;
            return;
        }
    } else {
        phase = .idle;
        return;
    }

    // Start recording
    phase = .recording;
    last_transcription_len = 0;
    _ = speech.startListening(&transcriptionCallback);
    if (active_view) |view| showIndicator(view);
}

fn tailFired(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    tail_timer = null;
    if (phase != .tail) return;

    // Stop recording and send text
    phase = .idle;
    speech.stopListening();
    hideIndicator();

    if (last_transcription_len > 0) {
        if (write_callback) |cb| cb(last_transcription[0..last_transcription_len]);
    }
    write_callback = null;
}

fn transcriptionCallback(text: []const u8, is_final: bool) void {
    const copy_len = @min(text.len, last_transcription.len);
    @memcpy(last_transcription[0..copy_len], text[0..copy_len]);
    last_transcription_len = copy_len;
    _ = is_final;
}

// ---------------------------------------------------------------------------
// Indicator UI
// ---------------------------------------------------------------------------

fn showIndicator(parent_view: objc.id) void {
    if (indicator_view != null) return;

    const NSView = objc.getClass("NSView") orelse return;
    const NSTextField = objc.getClass("NSTextField") orelse return;
    const NSColor = objc.getClass("NSColor") orelse return;
    const NSFont = objc.getClass("NSFont") orelse return;

    const indicator = objc.msgSend(objc.msgSend(NSView, objc.sel("alloc")), objc.sel("init"));

    // Device label
    const device_name = speech.getInputDeviceName();
    var buf: [512]u8 = undefined;
    const device_text = std.fmt.bufPrint(&buf, "{s}\n(System Default)", .{device_name}) catch "Unknown";
    const device_label = objc.msgSend(objc.msgSend(NSTextField, objc.sel("alloc")), objc.sel("init"));
    objc.msgSendVoid1(device_label, objc.sel("setStringValue:"), objc.nsString(device_text));
    objc.msgSendVoid1(device_label, objc.sel("setBezeled:"), objc.NO);
    objc.msgSendVoid1(device_label, objc.sel("setDrawsBackground:"), objc.NO);
    objc.msgSendVoid1(device_label, objc.sel("setEditable:"), objc.NO);
    objc.msgSendVoid1(device_label, objc.sel("setSelectable:"), objc.NO);
    objc.msgSendVoid1(device_label, objc.sel("setAlignment:"), @as(objc.NSUInteger, 1));
    const colorWithRGBA: *const fn (objc.id, objc.SEL, f64, f64, f64, f64) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const gray = colorWithRGBA(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.7, 0.7, 0.7, 1.0);
    objc.msgSendVoid1(device_label, objc.sel("setTextColor:"), gray);
    objc.msgSendVoid1(device_label, objc.sel("setFont:"), objc.msgSend1(NSFont, objc.sel("systemFontOfSize:"), @as(f64, 12.0)));
    objc.msgSendVoid(device_label, objc.sel("sizeToFit"));
    const device_frame = objc.msgSendRect(device_label, objc.sel("frame"));

    // Wave bar dimensions
    const bar_w: f64 = 4;
    const bar_gap: f64 = 3;
    const n_bars: usize = 5;
    const wave_w: f64 = @as(f64, @floatFromInt(n_bars)) * bar_w + @as(f64, @floatFromInt(n_bars - 1)) * bar_gap;
    const wave_h: f64 = 20;

    // Indicator size
    const content_w = @max(wave_w, device_frame.size.width);
    const content_h = wave_h + 12 + device_frame.size.height;
    const width: f64 = @max(content_w + 40, 220);
    const height: f64 = content_h + 30;

    // Center in parent
    const pf = objc.msgSendRect(parent_view, objc.sel("frame"));
    objc.msgSendVoid1(indicator, objc.sel("setFrame:"), objc.NSMakeRect(
        (pf.size.width - width) / 2,
        (pf.size.height - height) / 2,
        width,
        height,
    ));

    // Background
    const bg = colorWithRGBA(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.1, 0.1, 0.1, 0.9);
    objc.msgSendVoid1(indicator, objc.sel("setWantsLayer:"), objc.YES);
    const layer = objc.msgSend(indicator, objc.sel("layer"));
    if (@intFromPtr(layer) != 0) {
        objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), objc.msgSend(bg, objc.sel("CGColor")));
        objc.msgSendVoid1(layer, objc.sel("setCornerRadius:"), @as(f64, 10.0));
    }

    // Wave bars
    const green = colorWithRGBA(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.3, 0.9, 0.3, 1.0);
    const green_cg = objc.msgSend(green, objc.sel("CGColor"));
    const wave_x = (width - wave_w) / 2;
    const wave_cy = height - 15 - wave_h / 2;

    for (0..n_bars) |i| {
        const bar = objc.msgSend(objc.msgSend(NSView, objc.sel("alloc")), objc.sel("init"));
        const bx = wave_x + @as(f64, @floatFromInt(i)) * (bar_w + bar_gap);
        const bh: f64 = 8;
        objc.msgSendVoid1(bar, objc.sel("setFrame:"), objc.NSMakeRect(bx, wave_cy - bh / 2, bar_w, bh));
        objc.msgSendVoid1(bar, objc.sel("setWantsLayer:"), objc.YES);
        const bl = objc.msgSend(bar, objc.sel("layer"));
        if (@intFromPtr(bl) != 0) {
            objc.msgSendVoid1(bl, objc.sel("setBackgroundColor:"), green_cg);
            objc.msgSendVoid1(bl, objc.sel("setCornerRadius:"), @as(f64, 2.0));
        }
        objc.msgSendVoid1(indicator, objc.sel("addSubview:"), bar);
        wave_bars[i] = bar;
    }

    // Device label position
    objc.msgSendVoid1(device_label, objc.sel("setFrame:"), objc.NSMakeRect(
        (width - device_frame.size.width) / 2,
        wave_cy - wave_h / 2 - 12 - device_frame.size.height,
        device_frame.size.width,
        device_frame.size.height,
    ));

    objc.msgSendVoid1(indicator, objc.sel("addSubview:"), device_label);
    objc.msgSendVoid1(parent_view, objc.sel("addSubview:"), indicator);
    indicator_view = indicator;
    wave_phase = 0;

    // Start wave animation
    wave_timer = scheduleTimer("waveFired:", 0.15, true);
}

fn hideIndicator() void {
    cancelTimer(&wave_timer);
    if (indicator_view) |v| {
        objc.msgSendVoid(v, objc.sel("removeFromSuperview"));
        indicator_view = null;
    }
    for (&wave_bars) |*b| b.* = null;
}

fn waveFired(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    wave_phase = (wave_phase + 1) % 8;

    const patterns = [8][5]f64{
        .{ 6, 12, 18, 12, 6 },
        .{ 8, 14, 16, 14, 8 },
        .{ 12, 18, 12, 18, 12 },
        .{ 14, 16, 8, 16, 14 },
        .{ 18, 12, 6, 12, 18 },
        .{ 14, 8, 10, 8, 14 },
        .{ 12, 6, 14, 6, 12 },
        .{ 8, 10, 16, 10, 8 },
    };
    const p = patterns[wave_phase];

    for (0..5) |i| {
        const bar = wave_bars[i] orelse continue;
        const f = objc.msgSendRect(bar, objc.sel("frame"));
        const cy = f.origin.y + f.size.height / 2;
        objc.msgSendVoid1(bar, objc.sel("setFrame:"), objc.NSMakeRect(
            f.origin.x,
            cy - p[i] / 2,
            f.size.width,
            p[i],
        ));
    }
}

// ---------------------------------------------------------------------------
// Timer helpers
// ---------------------------------------------------------------------------

fn scheduleTimer(selector_name: [:0]const u8, interval: f64, repeats: bool) ?objc.id {
    const cls = timer_helper_class orelse return null;
    const NSTimer = objc.getClass("NSTimer") orelse return null;
    const helper = objc.msgSend(cls, objc.sel("new"));
    const timerFn: *const fn (objc.id, objc.SEL, f64, ?*anyopaque, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    return timerFn(
        NSTimer,
        objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        interval,
        helper,
        objc.sel(selector_name),
        null,
        if (repeats) objc.YES else objc.NO,
    );
}

fn cancelTimer(timer: *?objc.id) void {
    if (timer.*) |t| {
        objc.msgSendVoid(t, objc.sel("invalidate"));
        timer.* = null;
    }
}
