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

/// Centralized terminal state manager.
pub const TerminalManager = struct {
    allocator: std.mem.Allocator,
    terminals: [MAX_TERMINALS]?TermEntry,
    sessions: [MAX_TERMINALS]?Session,
    active_session: ?usize,
    bell_active: [MAX_TERMINALS]bool,

    const Self = @This();

    pub fn init(alloc: std.mem.Allocator) Self {
        return .{
            .allocator = alloc,
            .terminals = [_]?TermEntry{null} ** MAX_TERMINALS,
            .sessions = [_]?Session{null} ** MAX_TERMINALS,
            .active_session = null,
            .bell_active = [_]bool{false} ** MAX_TERMINALS,
        };
    }

    // -------------------------------------------------------------------------
    // Terminal slot management
    // -------------------------------------------------------------------------

    /// Find a free terminal slot.
    pub fn findFreeSlot(self: *Self) ?usize {
        for (&self.terminals, 0..) |*t, i| {
            if (t.* == null) return i;
        }
        return null;
    }

    /// Get a terminal entry by slot.
    pub fn getTerminal(self: *Self, slot: usize) ?*TermEntry {
        if (slot >= MAX_TERMINALS) return null;
        if (self.terminals[slot]) |*entry| return entry;
        return null;
    }

    /// Find a terminal entry by its view pointer.
    pub fn findByView(self: *Self, view: *anyopaque) ?*TermEntry {
        for (&self.terminals) |*t| {
            if (t.*) |*entry| {
                if (entry.view == view) return entry;
            }
        }
        return null;
    }

    /// Set a terminal entry at a slot.
    pub fn setTerminal(self: *Self, slot: usize, entry: TermEntry) void {
        if (slot < MAX_TERMINALS) {
            self.terminals[slot] = entry;
        }
    }

    /// Clear a terminal slot.
    pub fn clearTerminal(self: *Self, slot: usize) void {
        if (slot < MAX_TERMINALS) {
            self.terminals[slot] = null;
        }
    }

    /// Iterate over all active terminals.
    pub fn iterTerminals(self: *Self) TerminalIterator {
        return .{ .manager = self, .index = 0 };
    }

    pub const TerminalIterator = struct {
        manager: *Self,
        index: usize,

        pub fn next(self: *TerminalIterator) ?*TermEntry {
            while (self.index < MAX_TERMINALS) {
                const i = self.index;
                self.index += 1;
                if (self.manager.terminals[i]) |*entry| {
                    return entry;
                }
            }
            return null;
        }
    };

    // -------------------------------------------------------------------------
    // Session management
    // -------------------------------------------------------------------------

    /// Find a free session slot.
    pub fn findFreeSessionSlot(self: *Self) ?usize {
        for (&self.sessions, 0..) |*s, i| {
            if (s.* == null) return i;
        }
        return null;
    }

    /// Get a session by index.
    pub fn getSession(self: *Self, index: usize) ?*Session {
        if (index >= MAX_TERMINALS) return null;
        if (self.sessions[index]) |*session| return session;
        return null;
    }

    /// Get the active session.
    pub fn getActiveSession(self: *Self) ?*Session {
        const idx = self.active_session orelse return null;
        return self.getSession(idx);
    }

    /// Get the active session index.
    pub fn getActiveSessionIndex(self: *Self) ?usize {
        return self.active_session;
    }

    /// Set the active session.
    pub fn setActiveSession(self: *Self, index: ?usize) void {
        self.active_session = index;
    }

    /// Find a session by terminal_id.
    pub fn findSessionByTerminalId(self: *Self, terminal_id: []const u8) ?usize {
        for (&self.sessions, 0..) |*s, i| {
            if (s.*) |session| {
                if (std.mem.eql(u8, session.terminal_id, terminal_id)) return i;
            }
        }
        return null;
    }

    /// Get the terminal_id of the active session.
    pub fn getActiveTerminalId(self: *Self) ?[]const u8 {
        const session = self.getActiveSession() orelse return null;
        return session.terminal_id;
    }

    /// Set a session at an index.
    pub fn setSession(self: *Self, index: usize, session: Session) void {
        if (index < MAX_TERMINALS) {
            self.sessions[index] = session;
        }
    }

    /// Clear a session slot.
    pub fn clearSession(self: *Self, index: usize) void {
        if (index < MAX_TERMINALS) {
            self.sessions[index] = null;
        }
    }

    // -------------------------------------------------------------------------
    // Bell notifications
    // -------------------------------------------------------------------------

    /// Set bell active for a session.
    pub fn setBell(self: *Self, session_index: usize, active: bool) void {
        if (session_index < MAX_TERMINALS) {
            self.bell_active[session_index] = active;
        }
    }

    /// Check if bell is active for a session.
    pub fn isBellActive(self: *Self, session_index: usize) bool {
        if (session_index >= MAX_TERMINALS) return false;
        return self.bell_active[session_index];
    }

    /// Clear bell for a session.
    pub fn clearBell(self: *Self, session_index: usize) void {
        self.setBell(session_index, false);
    }
};

// ============================================================================
// Tests
// ============================================================================

test "findFreeSlot" {
    var tm = TerminalManager.init(std.testing.allocator);

    // All slots free initially
    try std.testing.expectEqual(@as(?usize, 0), tm.findFreeSlot());

    // Occupy slot 0
    tm.terminals[0] = TermEntry{
        .pty = undefined,
        .vterm = undefined,
        .view = @ptrFromInt(0x1234),
        .slot = 0,
    };

    // Should return slot 1 now
    try std.testing.expectEqual(@as(?usize, 1), tm.findFreeSlot());
}

test "findByView" {
    var tm = TerminalManager.init(std.testing.allocator);

    const view1: *anyopaque = @ptrFromInt(0x1000);
    const view2: *anyopaque = @ptrFromInt(0x2000);

    tm.terminals[5] = TermEntry{
        .pty = undefined,
        .vterm = undefined,
        .view = view1,
        .slot = 5,
    };

    const found = tm.findByView(view1);
    try std.testing.expect(found != null);
    try std.testing.expectEqual(@as(usize, 5), found.?.slot);

    const not_found = tm.findByView(view2);
    try std.testing.expect(not_found == null);
}

test "session management" {
    var tm = TerminalManager.init(std.testing.allocator);

    try std.testing.expect(tm.getActiveSession() == null);
    try std.testing.expectEqual(@as(?usize, 0), tm.findFreeSessionSlot());

    // Can't actually create a real session without SplitNode allocation,
    // but we can test the index management
    tm.active_session = 3;
    try std.testing.expectEqual(@as(?usize, 3), tm.getActiveSessionIndex());
}

test "bell notifications" {
    var tm = TerminalManager.init(std.testing.allocator);

    try std.testing.expect(!tm.isBellActive(5));

    tm.setBell(5, true);
    try std.testing.expect(tm.isBellActive(5));

    tm.clearBell(5);
    try std.testing.expect(!tm.isBellActive(5));
}

test "terminal iterator" {
    var tm = TerminalManager.init(std.testing.allocator);

    // Add some terminals
    tm.terminals[2] = TermEntry{
        .pty = undefined,
        .vterm = undefined,
        .view = @ptrFromInt(0x1000),
        .slot = 2,
    };
    tm.terminals[7] = TermEntry{
        .pty = undefined,
        .vterm = undefined,
        .view = @ptrFromInt(0x2000),
        .slot = 7,
    };

    var iter = tm.iterTerminals();
    var count: usize = 0;
    while (iter.next()) |_| {
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), count);
}
