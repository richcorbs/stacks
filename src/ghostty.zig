/// Thin wrapper around libghostty's C API.
///
/// libghostty provides:
///   - Terminal emulation (VT parsing, grid state)
///   - PTY management (fork, read/write)
///   - GPU-accelerated rendering via Metal
///   - Surface = one terminal instance (emulator + PTY + renderer)
///
/// We use it as a library: we create surfaces, embed their Metal views
/// in our own NSViews, and forward input events.

const std = @import("std");

// Import the libghostty C header.
// The build.zig adds the include path; the header is typically
// <ghostty_path>/include/ghostty.h
pub const c = @cImport({
    @cInclude("ghostty.h");
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Opaque handle to a ghostty surface (terminal + PTY + renderer).
pub const Surface = *anyopaque;

/// Opaque handle to the ghostty app runtime.
pub const App = *anyopaque;

/// Configuration for creating a new surface.
pub const SurfaceConfig = struct {
    cwd: ?[]const u8 = null,
    command: ?[]const u8 = null,
    cols: u16 = 80,
    rows: u16 = 24,
};

// ---------------------------------------------------------------------------
// Global app runtime
// ---------------------------------------------------------------------------

var global_app: ?App = null;

/// Initialize the ghostty runtime. Call once at startup.
pub fn initApp(config: AppConfig) !void {
    if (global_app != null) return;

    const cfg = c.ghostty_config_new();
    defer c.ghostty_config_free(cfg);

    // Apply configuration
    if (config.font_family) |family| {
        c.ghostty_config_set(cfg, "font-family", family.ptr, family.len);
    }
    if (config.font_size) |size| {
        var buf: [16]u8 = undefined;
        const s = std.fmt.bufPrint(&buf, "{d}", .{size}) catch "13";
        c.ghostty_config_set(cfg, "font-size", s.ptr, s.len);
    }

    // Set our dark theme colors
    c.ghostty_config_set(cfg, "background", "#0f141b", 7);
    c.ghostty_config_set(cfg, "foreground", "#d8efe7", 7);
    c.ghostty_config_set(cfg, "cursor-color", "#d8efe7", 7);

    global_app = c.ghostty_app_new(cfg) orelse return error.GhosttyInitFailed;
}

/// Shut down the ghostty runtime.
pub fn deinitApp() void {
    if (global_app) |app| {
        c.ghostty_app_free(app);
        global_app = null;
    }
}

pub const AppConfig = struct {
    font_family: ?[]const u8 = null,
    font_size: ?f64 = null,
};

// ---------------------------------------------------------------------------
// Surface lifecycle
// ---------------------------------------------------------------------------

/// Create a new terminal surface (spawns a PTY).
pub fn createSurface(config: SurfaceConfig) !Surface {
    const app = global_app orelse return error.AppNotInitialized;

    const surface_cfg = c.ghostty_surface_config_new();
    defer c.ghostty_surface_config_free(surface_cfg);

    if (config.cwd) |cwd| {
        c.ghostty_surface_config_set(surface_cfg, "working-directory", cwd.ptr, cwd.len);
    }
    if (config.command) |cmd| {
        c.ghostty_surface_config_set(surface_cfg, "command", cmd.ptr, cmd.len);
    }

    // Set initial size
    c.ghostty_surface_config_set_size(surface_cfg, config.cols, config.rows);

    const surface = c.ghostty_app_surface_new(app, surface_cfg) orelse
        return error.SurfaceCreateFailed;

    return @ptrCast(surface);
}

/// Destroy a terminal surface (kills the PTY).
pub fn destroySurface(surface: Surface) void {
    c.ghostty_surface_free(@ptrCast(surface));
}

/// Resize a surface to new dimensions.
pub fn surfaceResize(surface: Surface, cols: u16, rows: u16) void {
    c.ghostty_surface_set_size(@ptrCast(surface), cols, rows);
}

/// Write data to a surface's PTY (user input).
pub fn surfaceWrite(surface: Surface, data: []const u8) void {
    c.ghostty_surface_write(@ptrCast(surface), data.ptr, data.len);
}

/// Get the current working directory of a surface's foreground process.
/// Returns null if unavailable.
pub fn surfaceCwd(surface: Surface) ?[]const u8 {
    var buf: [4096]u8 = undefined;
    const len = c.ghostty_surface_cwd(@ptrCast(surface), &buf, buf.len);
    if (len == 0) return null;
    return buf[0..len];
}

/// Get the Metal CAMetalLayer for embedding in an NSView.
pub fn surfaceMetalLayer(surface: Surface) ?*anyopaque {
    return c.ghostty_surface_metal_layer(@ptrCast(surface));
}

/// Focus / unfocus a surface (affects cursor blink, selection, etc.).
pub fn surfaceSetFocus(surface: Surface, focused: bool) void {
    c.ghostty_surface_set_focus(@ptrCast(surface), if (focused) 1 else 0);
}

/// Forward a key event to the surface.
pub fn surfaceKeyEvent(surface: Surface, event: *anyopaque) void {
    c.ghostty_surface_key(@ptrCast(surface), @ptrCast(event));
}

/// Forward a scroll event to the surface.
pub fn surfaceScrollEvent(surface: Surface, dx: f64, dy: f64) void {
    c.ghostty_surface_scroll(@ptrCast(surface), dx, dy);
}

/// Forward a mouse event to the surface.
pub fn surfaceMouseEvent(surface: Surface, event: *anyopaque) void {
    c.ghostty_surface_mouse(@ptrCast(surface), @ptrCast(event));
}

/// Get the title reported by the shell (e.g. via OSC 0/2).
pub fn surfaceTitle(surface: Surface) ?[]const u8 {
    var buf: [1024]u8 = undefined;
    const len = c.ghostty_surface_title(@ptrCast(surface), &buf, buf.len);
    if (len == 0) return null;
    return buf[0..len];
}

/// Check if the surface's child process has exited.
pub fn surfaceHasExited(surface: Surface) bool {
    return c.ghostty_surface_has_exited(@ptrCast(surface)) != 0;
}

/// Get the exit code of the child process (only valid after surfaceHasExited).
pub fn surfaceExitCode(surface: Surface) i32 {
    return c.ghostty_surface_exit_code(@ptrCast(surface));
}

/// Request the surface to perform a split. This is handled by Ghostty
/// internally — it creates a new surface as a sibling. We use our own
/// split tree instead, so this is here only for reference. We call
/// createSurface() directly in our split logic.
pub fn surfaceSplit(surface: Surface, direction: c.ghostty_split_direction_e) void {
    c.ghostty_surface_split(@ptrCast(surface), direction);
}

// ---------------------------------------------------------------------------
// Clipboard integration
// ---------------------------------------------------------------------------

/// Get selected text from a surface.
pub fn surfaceGetSelection(surface: Surface) ?[]const u8 {
    var buf: [64 * 1024]u8 = undefined;
    const len = c.ghostty_surface_selection(@ptrCast(surface), &buf, buf.len);
    if (len == 0) return null;
    return buf[0..len];
}

/// Paste text into a surface.
pub fn surfacePaste(surface: Surface, text: []const u8) void {
    c.ghostty_surface_paste(@ptrCast(surface), text.ptr, text.len);
}
