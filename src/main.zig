const std = @import("std");
const app = @import("app.zig");
const objc = @import("objc.zig");
const window_ui = @import("ui/window.zig");

pub fn main() !void {
    // Use c_allocator globally — term_text_view.zig also uses c_allocator for
    // scrollback, split strings, and cwd strings. Using the same allocator
    // everywhere allows safe free() of strings regardless of origin.
    const allocator = std.heap.c_allocator;

    // Initialize application state
    var application = try app.App.init(allocator);
    defer application.deinit();

    // Launch the macOS AppKit run loop
    window_ui.launchApp(&application);
}
