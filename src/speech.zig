/// Speech-to-text module — on-device speech recognition using macOS Speech framework.
///
/// Uses SFSpeechRecognizer with requiresOnDeviceRecognition for privacy.
/// Activated by holding shift key (push-to-talk).
const std = @import("std");

// C interface to speech_helper.m
const c = struct {
    extern fn speech_init() c_int;
    extern fn speech_start(callback: *const fn ([*:0]const u8, c_int, ?*anyopaque) callconv(.c) void, context: ?*anyopaque) c_int;
    extern fn speech_stop() void;
    extern fn speech_is_listening() c_int;
    extern fn speech_cleanup() void;
    extern fn speech_get_input_device_name() [*:0]const u8;
};

// Zig callback wrapper
var zig_callback: ?*const fn ([]const u8, bool) void = null;

fn transcriptionCallbackWrapper(text: [*:0]const u8, is_final: c_int, _: ?*anyopaque) callconv(.c) void {
    if (zig_callback) |cb| {
        const slice = std.mem.span(text);
        cb(slice, is_final != 0);
    }
}

/// Initialize the speech recognition system.
/// Returns true if successfully initialized.
pub fn init() bool {
    return c.speech_init() != 0;
}

/// Start listening for speech.
/// The callback receives (text, is_final) for each transcription update.
pub fn startListening(callback: *const fn ([]const u8, bool) void) bool {
    zig_callback = callback;
    return c.speech_start(&transcriptionCallbackWrapper, null) != 0;
}

/// Stop listening and clean up.
pub fn stopListening() void {
    c.speech_stop();
    zig_callback = null;
}

/// Check if currently listening.
pub fn isListening() bool {
    return c.speech_is_listening() != 0;
}

/// Clean up all resources.
pub fn cleanup() void {
    c.speech_cleanup();
    zig_callback = null;
}

/// Get the name of the current input device.
pub fn getInputDeviceName() []const u8 {
    return std.mem.span(c.speech_get_input_device_name());
}
