const std = @import("std");
const app = @import("app.zig");
const objc = @import("objc.zig");
const window_ui = @import("ui/window.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Initialize application state
    var application = try app.App.init(allocator);
    defer application.deinit();

    // Launch the macOS AppKit run loop
    window_ui.launchApp(&application);
}
