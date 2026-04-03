/// Terminal state management — centralized state for terminal sessions.
///
/// This module owns the terminal entries, sessions, and related state.
/// It provides methods to access and manipulate terminal state without
/// exposing the underlying arrays directly.
const std = @import("std");
const Pty = @import("pty.zig").Pty;
const VTerm = @import("vt.zig").VTerm;
const vt = @import("vt.zig");
const split_tree = @import("split_tree.zig");
const scrollback = @import("scrollback.zig");
const selection = @import("selection.zig");
const kitty_graphics = @import("kitty_graphics.zig");

pub const MAX_TERMINALS = 32;
pub const MAX_SCROLLBACK = 10000;

/// A single terminal pane with PTY, vterm state, and view.
pub const TermEntry = struct {
    pty: Pty,
    vterm: VTerm,
    view: *anyopaque, // objc.id - opaque to avoid importing objc here
    slot: usize,
    needs_redraw: bool = true,
    scroll_offset: i32 = 0,
    scrollback: scrollback.ScrollList(MAX_SCROLLBACK + 1) = .{},
    selection: selection.Selection = .{},
    cursor_visible: bool = true,
    image_state: kitty_graphics.ImageState = .{},
};

/// A session corresponds to one sidebar terminal entry and holds a split tree.
/// Sessions are keyed by terminal_id (stable across sidebar rebuilds).
pub const Session = struct {
    root: *split_tree.SplitNode,
    focused_slot: usize,
    cwd: []const u8,
    command: ?[]const u8,
    terminal_id: []const u8,
};
// TerminalManager was removed — types above are imported directly by term_text_view.zig.
