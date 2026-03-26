/// Terminal view — renders a VT100 terminal grid backed by libvterm.
///
/// Uses a custom NSView that draws the character grid via Core Graphics,
/// and a PTY for the shell process.
const std = @import("std");
const objc = @import("../objc.zig");
const Pty = @import("../pty.zig").Pty;
const VTerm = @import("../vt.zig").VTerm;
const vt_mod = @import("../vt.zig");
const split_tree = @import("../split_tree.zig");
const scrollback = @import("../scrollback.zig");
const selection_mod = @import("../selection.zig");
const terminal_state = @import("../terminal_state.zig");
const term_keys = @import("../term_keys.zig");
const box_drawing = @import("../box_drawing.zig");

const MAX_TERMS = terminal_state.MAX_TERMINALS;
const MAX_SCROLLBACK = terminal_state.MAX_SCROLLBACK;

// Import types from terminal_state (single source of truth)
const TermEntry = terminal_state.TermEntry;
const Session = terminal_state.Session;

var terminals: [MAX_TERMS]?TermEntry = [_]?TermEntry{null} ** MAX_TERMS;
var poll_timer: ?objc.id = null;
var term_view_class: ?objc.id = null;

// --- Font metrics ---
var font_size: f64 = 13.0;
var cell_width: f64 = 7.8;
var cell_height: f64 = 16.0;
var cached_nscolor_key: ?objc.id = null;
var cached_nsfont_key: ?objc.id = null;
var cached_menlo_name: ?objc.id = null;
var cached_font: ?objc.id = null;
var cached_font_size: f64 = 0;

fn getCachedNSColorKey() objc.id {
    if (cached_nscolor_key) |k| return k;
    cached_nscolor_key = objc.msgSend(objc.nsString("NSColor"), objc.sel("retain"));
    return cached_nscolor_key.?;
}

fn getCachedNSFontKey() objc.id {
    if (cached_nsfont_key) |k| return k;
    cached_nsfont_key = objc.msgSend(objc.nsString("NSFont"), objc.sel("retain"));
    return cached_nsfont_key.?;
}

fn getCachedFont() objc.id {
    if (cached_font != null and cached_font_size == font_size) return cached_font.?;
    const NSFont = objc.getClass("NSFont") orelse unreachable;
    const monoFont: *const fn (objc.id, objc.SEL, objc.id, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    if (cached_menlo_name == null) {
        cached_menlo_name = objc.msgSend(objc.nsString("Menlo"), objc.sel("retain"));
    }
    const f = monoFont(NSFont, objc.sel("fontWithName:size:"), cached_menlo_name.?, font_size);
    cached_font = objc.msgSend(f, objc.sel("retain"));
    cached_font_size = font_size;
    return cached_font.?;
}

fn updateCellMetrics() void {
    // Measure actual rendered width by creating a CTLine with 10 characters
    // and dividing by 10 — this gives the exact advance Core Text uses.
    const CT = struct {
        extern "CoreText" fn CTLineCreateWithAttributedString(attrString: *anyopaque) *anyopaque;
        extern "CoreText" fn CTLineGetTypographicBounds(line: *anyopaque, ascent: ?*f64, descent: ?*f64, leading: ?*f64) f64;
        extern "CoreFoundation" fn CFRelease(cf: *anyopaque) void;
    };

    const font = getCachedFont();

    // Create a 10-char attributed string and measure via CTLine
    const test_str = objc.nsString("MMMMMMMMMM"); // 10 M's
    const NSMutableAS = objc.getClass("NSMutableAttributedString") orelse return;
    const astr = objc.msgSend1(
        objc.msgSend(NSMutableAS, objc.sel("alloc")),
        objc.sel("initWithString:"),
        test_str,
    );
    const addAttr: *const fn (objc.id, objc.SEL, objc.id, objc.id, objc.NSRange) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    const full_len = objc.msgSendUInt(astr, objc.sel("length"));
    addAttr(astr, objc.sel("addAttribute:value:range:"),
        getCachedNSFontKey(), font, .{ .location = 0, .length = full_len });

    const ct_line = CT.CTLineCreateWithAttributedString(@ptrCast(astr));
    defer CT.CFRelease(ct_line);

    var ascent: f64 = 0;
    var descent: f64 = 0;
    var leading: f64 = 0;
    const total_width = CT.CTLineGetTypographicBounds(ct_line, &ascent, &descent, &leading);

    cell_width = total_width / 10.0;
    cell_height = @ceil(ascent + descent + leading);
}

// Re-export from scrollback module
const ScrollLine = scrollback.ScrollLine;
const ScrollList = scrollback.ScrollList(MAX_SCROLLBACK + 1);

const allocator = std.heap.c_allocator;

// Re-export from selection module
const Selection = selection_mod.Selection;

// TermEntry imported from terminal_state above

// ---------------------------------------------------------------------------
// Split tree
// ---------------------------------------------------------------------------

// Re-export from split_tree for convenience
pub const SplitDirection = split_tree.SplitDirection;
const SplitNode = split_tree.SplitNode;

/// Deserialize a split tree from a string and create terminal views for each leaf.
/// The first leaf gets the configured command; additional leaves get plain shells.
fn deserializeSplitTree(input: []const u8, cwd: []const u8, command: ?[]const u8) ?*SplitNode {
    // Parse the tree structure (leaves get sequential indices 0, 1, 2, ...)
    const parsed = split_tree.parseStructure(allocator, input) orelse return null;

    // Create terminal views for each leaf, mapping parsed indices to actual slots
    var slot_map: [32]usize = undefined;
    for (0..parsed.leaf_count) |i| {
        const slot = findFreeSlot() orelse {
            // Cleanup on failure: destroy any terminals we already created
            for (0..i) |j| destroyTerminalAtSlot(slot_map[j]);
            parsed.root.destroyTree(allocator);
            allocator.destroy(parsed.root);
            return null;
        };
        // Only the first leaf gets the configured command
        const leaf_command = if (i == 0) command else null;
        _ = createTerminalViewAtSlot(slot, cwd, leaf_command) orelse {
            for (0..i) |j| destroyTerminalAtSlot(slot_map[j]);
            parsed.root.destroyTree(allocator);
            allocator.destroy(parsed.root);
            return null;
        };
        slot_map[i] = slot;
    }

    // Remap leaf indices to actual slots
    remapLeafSlots(parsed.root, &slot_map);

    return parsed.root;
}

/// Recursively update leaf slot values from sequential indices to actual terminal slots.
fn remapLeafSlots(node: *SplitNode, slot_map: []const usize) void {
    switch (node.*) {
        .leaf => |idx| {
            if (idx < slot_map.len) {
                node.* = .{ .leaf = slot_map[idx] };
            }
        },
        .split => |s| {
            remapLeafSlots(s.first, slot_map);
            remapLeafSlots(s.second, slot_map);
        },
    }
}

/// Serialize the active session's split tree and save to project store.
fn saveSplitState() void {
    const sidebar = @import("sidebar.zig");
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    var buf: [512]u8 = undefined;
    const serialized = session.root.serialize(&buf);
    if (serialized.len == 0) return;

    const split_str = allocator.dupe(u8, serialized) catch return;

    // Find the terminal in the project store by session's terminal_id
    const app = sidebar.g_sidebar_app orelse return;
    const terminal = findTerminalInStore(app, session.terminal_id) orelse return;
    if (terminal.splits) |old| allocator.free(old);
    terminal.splits = split_str;
    saveCwdForTerminal(terminal, session);
    app.store.save() catch {};
}

/// Look up a Terminal struct in the project store by terminal_id.
fn findTerminalInStore(app: *@import("../app.zig").App, terminal_id: []const u8) ?*@import("../project.zig").Terminal {
    for (app.projects()) |proj| {
        for (proj.terminals.items) |*t| {
            if (std.mem.eql(u8, t.id, terminal_id)) return t;
        }
    }
    return null;
}

/// Save the focused pane's live cwd to the terminal struct.
fn saveCwdForTerminal(t: *@import("../project.zig").Terminal, session: *Session) void {
    if (terminals[session.focused_slot]) |*entry| {
        var cwd_buf: [4096]u8 = undefined;
        if (entry.pty.getCwd(&cwd_buf)) |live_cwd| {
            if (t.cwd) |old| allocator.free(old);
            t.cwd = allocator.dupe(u8, live_cwd) catch return;
        }
    }
}

/// Save cwd for the active session (called on terminal switch and app quit).
pub fn saveActiveCwd() void {
    const sidebar = @import("sidebar.zig");
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    const app = sidebar.g_sidebar_app orelse return;
    const terminal = findTerminalInStore(app, session.terminal_id) orelse return;
    saveCwdForTerminal(terminal, session);
    app.store.save() catch {};
}

// Session imported from terminal_state above

var sessions: [MAX_TERMS]?Session = [_]?Session{null} ** MAX_TERMS;
var active_session: ?usize = null; // index into sessions[] (NOT sidebar position)

/// Get the terminal_id of the currently active session, if any.
pub fn getActiveTerminalId() ?[]const u8 {
    const si = active_session orelse return null;
    if (si >= MAX_TERMS) return null;
    const session = sessions[si] orelse return null;
    return session.terminal_id;
}

/// Find a session by terminal_id, returning its index in sessions[].
pub fn findSessionByTerminalId(terminal_id: []const u8) ?usize {
    for (&sessions, 0..) |*s, i| {
        if (s.*) |session| {
            if (std.mem.eql(u8, session.terminal_id, terminal_id)) return i;
        }
    }
    return null;
}

/// Find a free slot in the sessions[] array.
fn findFreeSessionSlot() ?usize {
    for (&sessions, 0..) |*s, i| {
        if (s.* == null) return i;
    }
    return null;
}

// Bell notification tracking — indexed by sessions[] slot (stable)
pub var bell_active: [MAX_TERMS]bool = [_]bool{false} ** MAX_TERMS;

// Divider drag state
const DividerInfo = struct {
    node: *SplitNode, // the split node this divider belongs to
    rect: objc.NSRect, // the divider hit area
};
var dividers: [64]?DividerInfo = [_]?DividerInfo{null} ** 64;
var divider_count: usize = 0;
var dragging_divider: ?*SplitNode = null;
var drag_direction: SplitDirection = .horizontal;
var drag_origin: f64 = 0; // mouse position at drag start
var drag_start_ratio: f64 = 0.5;
var drag_total_size: f64 = 0; // total width or height of the split

/// Find a free terminal slot.
fn findFreeSlot() ?usize {
    for (&terminals, 0..) |*t, i| {
        if (t.* == null) return i;
    }
    return null;
}

/// Create a terminal view for the given working directory and optional command.
/// Finds the first free slot.
pub fn createTerminalView(cwd: []const u8, command: ?[]const u8) ?objc.id {
    return createTerminalViewAtSlot(findFreeSlot() orelse return null, cwd, command);
}

/// Get or create a session for a terminal, keyed by terminal_id.
pub fn getOrCreateSession(terminal_id: []const u8, cwd: []const u8, command: ?[]const u8) bool {
    // Look up existing session by terminal_id
    if (findSessionByTerminalId(terminal_id)) |si| {
        active_session = si;
        bell_active[si] = false;

        // Check if the sole pane's process has exited — respawn it
        const session = &(sessions[si].?);
        var leaves: std.ArrayListUnmanaged(usize) = .{};
        defer leaves.deinit(allocator);
        session.root.collectLeaves(allocator, &leaves);
        if (leaves.items.len == 1) {
            const slot = leaves.items[0];
            if (slot < MAX_TERMS) {
                if (terminals[slot]) |*entry| {
                    if (entry.pty.hasExited()) {
                        entry.pty.close();
                        entry.pty = @import("../pty.zig").Pty.spawn(cwd, command) catch return true;
                        // Clear the vterm screen and scrollback
                        entry.vterm.deinit();
                        entry.vterm = @import("../vt.zig").VTerm.init(24, 80) catch return true;
                        entry.scroll_offset = 0;
                        entry.scrollback.clearRetainingCapacity(allocator);
                        // Re-register callbacks on new vterm
                        registerScrollbackCallbacks(slot, &entry.vterm);
                        registerOutputCallback(&terminals[slot].?);
                    }
                }
            }
        }
        return true;
    }

    // No existing session — create a new one
    const session_slot = findFreeSessionSlot() orelse return false;

    // Check for saved split layout
    const sidebar = @import("sidebar.zig");
    const saved_splits: ?[]const u8 = blk: {
        const app = sidebar.g_sidebar_app orelse break :blk null;
        for (app.projects()) |proj| {
            for (proj.terminals.items) |t| {
                if (std.mem.eql(u8, t.id, terminal_id)) {
                    break :blk t.splits;
                }
            }
        }
        break :blk null;
    };

    // Create terminal tree from saved layout or single pane
    const root = if (saved_splits) |splits| restore: {
        const restored = deserializeSplitTree(splits, cwd, command);
        if (restored) |r| {
            // Don't rebalance - use the saved ratios from serialization
            break :restore r;
        }
        // Fallback to single pane
        const slot = findFreeSlot() orelse return false;
        _ = createTerminalViewAtSlot(slot, cwd, command) orelse return false;
        break :restore split_tree.createLeaf(allocator, slot) orelse return false;
    } else single: {
        const slot = findFreeSlot() orelse return false;
        _ = createTerminalViewAtSlot(slot, cwd, command) orelse return false;
        break :single split_tree.createLeaf(allocator, slot) orelse return false;
    };

    // Find first leaf for focus
    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    root.collectLeaves(allocator, &leaves);
    const focused = if (leaves.items.len > 0) leaves.items[0] else 0;

    // Dupe the terminal_id so it's stable
    const id_copy = allocator.dupe(u8, terminal_id) catch return false;

    sessions[session_slot] = .{
        .root = root,
        .focused_slot = focused,
        .cwd = cwd,
        .command = command,
        .terminal_id = id_copy,
    };
    active_session = session_slot;
    return true;
}

/// Layout the active session's split tree within the given rect.
pub fn layoutActiveSession(panel: objc.id) void {
    const window_ui = @import("window.zig");
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
    last_panel_width = bounds.size.width;
    last_panel_height = bounds.size.height;

    // Reset divider tracking
    divider_count = 0;

    // First remove all subviews (except header)
    const subviews = objc.msgSend(panel, objc.sel("subviews"));
    objc.msgSendVoid1(subviews, objc.sel("makeObjectsPerformSelector:"), objc.sel("removeFromSuperview"));

    // Re-add and position header
    const header_h = window_ui.HEADER_HEIGHT;
    if (window_ui.header_view) |header| {
        objc.msgSendVoid1(panel, objc.sel("addSubview:"), header);
        const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setFrame(header, objc.sel("setFrame:"), objc.NSMakeRect(0, bounds.size.height - header_h, bounds.size.width, header_h));

        // Position labels inside header
        if (window_ui.header_name_label) |nl| {
            setFrame(nl, objc.sel("setFrame:"), objc.NSMakeRect(15, 12, 300, 20));
        }
        // Reposition git label to right edge of panel
        if (window_ui.header_git_label) |gl| {
            const gl_frame = objc.msgSendRect(gl, objc.sel("frame"));
            const w = gl_frame.size.width;
            if (w > 0) {
                setFrame(gl, objc.sel("setFrame:"), objc.NSMakeRect(bounds.size.width - w - 16, 12, w, 20));
            }
        }
        // Hide changes label (unused)
        if (window_ui.header_git_changes_label) |cl| {
            setFrame(cl, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 0, 0));
        }
    }

    // Terminal area is below the header
    const term_bounds = objc.NSMakeRect(0, 0, bounds.size.width, bounds.size.height - header_h);

    // Recursively add terminal views in the area below the header
    layoutNode(session.root, panel, term_bounds, session.focused_slot);

    // Sync all terminal sizes to their new frames
    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    session.root.collectLeaves(allocator, &leaves);
    for (leaves.items) |slot| {
        if (slot < MAX_TERMS) {
            if (terminals[slot]) |*entry| {
                syncTermSize(entry);
                const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setBool(entry.view, objc.sel("setNeedsDisplay:"), objc.YES);
            }
        }
    }

    // Ensure focused pane has keyboard focus
    if (terminals[session.focused_slot]) |*entry| {
        const win = objc.msgSend(entry.view, objc.sel("window"));
        if (@intFromPtr(win) != 0) {
            objc.msgSendVoid1(win, objc.sel("makeFirstResponder:"), entry.view);
        }
    }
}

fn layoutNode(node: *SplitNode, parent: objc.id, rect: objc.NSRect, focused_slot: usize) void {
    switch (node.*) {
        .leaf => |slot| {
            if (slot < MAX_TERMS) {
                if (terminals[slot]) |*entry| {
                    // Inset to account for focus border and prevent right-edge clipping
                    const inset: f64 = 4.0;
                    const inset_rect = objc.NSMakeRect(
                        rect.origin.x + inset,
                        rect.origin.y + inset,
                        rect.size.width - inset * 2,
                        rect.size.height - inset * 2,
                    );
                    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
                        @ptrCast(&objc.c.objc_msgSend);
                    setFrame(entry.view, objc.sel("setFrame:"), inset_rect);
                    objc.msgSendVoid1(parent, objc.sel("addSubview:"), entry.view);

                    // Show focus border
                    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                        @ptrCast(&objc.c.objc_msgSend);
                    setBool(entry.view, objc.sel("setWantsLayer:"), objc.YES);
                    const layer = objc.msgSend(entry.view, objc.sel("layer"));

                    if (slot == focused_slot) {
                        const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
                            @ptrCast(&objc.c.objc_msgSend);
                        setBorderWidth(layer, objc.sel("setBorderWidth:"), 1.0);

                        const NSColor = objc.getClass("NSColor") orelse return;
                        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
                            @ptrCast(&objc.c.objc_msgSend);
                        const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.29, 0.565, 0.851, 1.0);
                        const cgColor = objc.msgSend(color, objc.sel("CGColor"));
                        objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), cgColor);
                    } else {
                        const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
                            @ptrCast(&objc.c.objc_msgSend);
                        setBorderWidth(layer, objc.sel("setBorderWidth:"), 0.5);

                        const NSColor = objc.getClass("NSColor") orelse return;
                        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
                            @ptrCast(&objc.c.objc_msgSend);
                        const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.24, 0.3, 1.0); // subtle dark border
                        const cgColor = objc.msgSend(color, objc.sel("CGColor"));
                        objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), cgColor);
                    }
                }
            }
        },
        .split => |s| {
            const gap: f64 = 6.0; // wider gap for easier dragging
            if (s.direction == .horizontal) {
                const first_w = (rect.size.width - gap) * s.ratio;
                const second_w = rect.size.width - gap - first_w;
                const first_rect = objc.NSMakeRect(rect.origin.x, rect.origin.y, first_w, rect.size.height);
                const second_rect = objc.NSMakeRect(rect.origin.x + first_w + gap, rect.origin.y, second_w, rect.size.height);

                // Record divider hit area
                if (divider_count < dividers.len) {
                    dividers[divider_count] = .{
                        .node = @constCast(node),
                        .rect = objc.NSMakeRect(rect.origin.x + first_w - 3, rect.origin.y, gap + 6, rect.size.height),
                    };
                    divider_count += 1;
                }

                layoutNode(s.first, parent, first_rect, focused_slot);
                layoutNode(s.second, parent, second_rect, focused_slot);
            } else {
                const first_h = (rect.size.height - gap) * s.ratio;
                const second_h = rect.size.height - gap - first_h;
                const first_rect = objc.NSMakeRect(rect.origin.x, rect.origin.y + second_h + gap, rect.size.width, first_h);
                const second_rect = objc.NSMakeRect(rect.origin.x, rect.origin.y, rect.size.width, second_h);

                // Record divider hit area
                if (divider_count < dividers.len) {
                    dividers[divider_count] = .{
                        .node = @constCast(node),
                        .rect = objc.NSMakeRect(rect.origin.x, rect.origin.y + second_h - 3, rect.size.width, gap + 6),
                    };
                    divider_count += 1;
                }

                layoutNode(s.first, parent, first_rect, focused_slot);
                layoutNode(s.second, parent, second_rect, focused_slot);
            }
        },
    }
}

/// Update focus borders on all panes without re-laying out.
fn updateFocusBorders(session: *Session) void {
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    session.root.collectLeaves(allocator, &leaves);

    for (leaves.items) |slot| {
        if (terminals[slot]) |*entry| {
            const layer = objc.msgSend(entry.view, objc.sel("layer"));
            if (slot == session.focused_slot) {
                setBorderWidth(layer, objc.sel("setBorderWidth:"), 1.0);
                const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.29, 0.565, 0.851, 1.0);
                objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), objc.msgSend(color, objc.sel("CGColor")));
            } else {
                setBorderWidth(layer, objc.sel("setBorderWidth:"), 0.5);
                const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.24, 0.3, 1.0);
                objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), objc.msgSend(color, objc.sel("CGColor")));
            }
        }
    }
}

/// Split the focused pane in the active session.
pub fn splitFocused(direction: SplitDirection) void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    // Find the focused leaf node
    const leaf_node = session.root.findLeaf(session.focused_slot) orelse return;

    // Inherit cwd from the focused terminal's live working directory
    var cwd_buf: [4096]u8 = undefined;
    const split_cwd = if (terminals[session.focused_slot]) |*entry|
        entry.pty.getCwd(&cwd_buf) orelse session.cwd
    else
        session.cwd;

    const new_slot = findFreeSlot() orelse return;
    _ = createTerminalViewAtSlot(new_slot, split_cwd, null) orelse return;

    // Replace the leaf with a split
    const old_slot = leaf_node.leaf;
    const first = split_tree.createLeaf(allocator, old_slot) orelse return;
    const second = split_tree.createLeaf(allocator, new_slot) orelse return;

    leaf_node.* = .{ .split = .{
        .direction = direction,
        .first = first,
        .second = second,
        .ratio = 0.5,
    } };

    // Rebalance so all panes along this axis get equal space
    session.root.rebalanceAxis(direction);

    session.focused_slot = new_slot;

    // Persist split layout
    saveSplitState();
}

/// Close the focused pane in the active session, with confirmation.
pub fn closeFocusedPane() void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    // Can't close if it's the only pane
    const leaf_node = session.root.findLeaf(session.focused_slot) orelse return;
    const parent_node = session.root.findParent(leaf_node) orelse return;

    // Skip confirmation if the shell has already exited
    const already_exited = if (terminals[session.focused_slot]) |*entry| entry.pty.hasExited() else false;
    if (!already_exited) {
        const NSAlert = objc.getClass("NSAlert") orelse return;
        const alert = objc.msgSend(NSAlert, objc.sel("new"));
        objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Close Pane"));
        objc.msgSendVoid1(alert, objc.sel("setInformativeText:"), objc.nsString("Close this terminal pane?"));
        objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Close"));
        objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

        const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
        const result = objc.msgSendUInt(alert, objc.sel("runModal"));
        if (result != NSAlertFirstButtonReturn) return;
    }

    // Destroy the focused terminal
    destroyTerminalAtSlot(session.focused_slot);

    // Replace parent split with the sibling
    const sibling = if (parent_node.split.first == leaf_node) parent_node.split.second else parent_node.split.first;
    const sibling_copy = sibling.*;
    allocator.destroy(leaf_node);
    allocator.destroy(sibling);
    parent_node.* = sibling_copy;

    // Focus the first leaf in the remaining tree
    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    parent_node.collectLeaves(allocator, &leaves);
    if (leaves.items.len > 0) {
        session.focused_slot = leaves.items[0];
        // Make the new focused pane the first responder for keyboard input
        if (terminals[leaves.items[0]]) |*entry| {
            const win = objc.msgSend(entry.view, objc.sel("window"));
            if (@intFromPtr(win) != 0) {
                objc.msgSendVoid1(win, objc.sel("makeFirstResponder:"), entry.view);
            }
        }
    }

    // Persist split layout
    saveSplitState();
}

/// Cycle focus to the next/previous pane.
pub fn cycleFocus(forward: bool) void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    session.root.collectLeaves(allocator, &leaves);

    if (leaves.items.len <= 1) return;

    // Find current focused index
    for (leaves.items, 0..) |slot, i| {
        if (slot == session.focused_slot) {
            if (forward) {
                session.focused_slot = leaves.items[(i + 1) % leaves.items.len];
            } else {
                session.focused_slot = leaves.items[(i + leaves.items.len - 1) % leaves.items.len];
            }
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Panel-level mouse handling for divider dragging
// ---------------------------------------------------------------------------

pub fn handlePanelMouseMoved(panel: objc.id, event: objc.id) void {
    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const loc = convertPoint(panel, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);

    const NSCursor = objc.getClass("NSCursor") orelse return;

    for (dividers[0..divider_count]) |maybe_div| {
        const div = maybe_div orelse continue;
        if (loc.x >= div.rect.origin.x and loc.x <= div.rect.origin.x + div.rect.size.width and
            loc.y >= div.rect.origin.y and loc.y <= div.rect.origin.y + div.rect.size.height)
        {
            if (div.node.split.direction == .horizontal) {
                const cursor = objc.msgSend(NSCursor, objc.sel("resizeLeftRightCursor"));
                objc.msgSendVoid(cursor, objc.sel("set"));
            } else {
                const cursor = objc.msgSend(NSCursor, objc.sel("resizeUpDownCursor"));
                objc.msgSendVoid(cursor, objc.sel("set"));
            }
            return;
        }
    }

    // Not over a divider — reset to arrow
    const cursor = objc.msgSend(NSCursor, objc.sel("arrowCursor"));
    objc.msgSendVoid(cursor, objc.sel("set"));
}

pub fn handlePanelMouseDown(panel: objc.id, event: objc.id) void {
    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const loc = convertPoint(panel, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);

    // Check if click is on a divider
    for (dividers[0..divider_count]) |maybe_div| {
        const div = maybe_div orelse continue;
        if (loc.x >= div.rect.origin.x and loc.x <= div.rect.origin.x + div.rect.size.width and
            loc.y >= div.rect.origin.y and loc.y <= div.rect.origin.y + div.rect.size.height)
        {
            dragging_divider = div.node;
            drag_direction = div.node.split.direction;
            drag_start_ratio = div.node.split.ratio;
            if (drag_direction == .horizontal) {
                drag_origin = loc.x;
            } else {
                drag_origin = loc.y;
            }
            const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
            drag_total_size = if (drag_direction == .horizontal) bounds.size.width else bounds.size.height;
            return;
        }
    }
}

pub fn handlePanelMouseDragged(panel: objc.id, event: objc.id) void {
    const div_node = dragging_divider orelse return;

    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const loc = convertPoint(panel, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);

    const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
    const total = if (div_node.split.direction == .horizontal) bounds.size.width else bounds.size.height;
    if (total <= 0) return;

    const current_pos = if (div_node.split.direction == .horizontal) loc.x else loc.y;
    const delta = current_pos - drag_origin;
    const ratio_delta = if (div_node.split.direction == .vertical) -delta / total else delta / total;

    div_node.split.ratio = @max(0.1, @min(0.9, drag_start_ratio + ratio_delta));
    layoutActiveSession(panel);
}

pub fn handlePanelMouseUp() void {
    if (dragging_divider != null) {
        dragging_divider = null;
        saveSplitState(); // Persist new ratio
    }
}

/// Get the focused terminal's view for makeFirstResponder.
pub fn getFocusedView() ?objc.id {
    const session_idx = active_session orelse return null;
    if (session_idx >= MAX_TERMS) return null;
    const session = sessions[session_idx] orelse return null;
    if (session.focused_slot < MAX_TERMS) {
        if (terminals[session.focused_slot]) |*entry| {
            return entry.view;
        }
    }
    return null;
}

fn createTerminalViewAtSlot(slot: usize, cwd: []const u8, command: ?[]const u8) ?objc.id {
    if (slot >= MAX_TERMS) return null;
    if (terminals[slot] != null) return null; // already occupied

    const vterm = VTerm.init(24, 80) catch return null;
    var pty = Pty.spawn(cwd, command) catch return null;
    pty.resize(80, 24);

    if (term_view_class == null) {
        term_view_class = registerTermViewClass();
        speech_indicator.init();
    }
    const cls = term_view_class orelse return null;
    const view = objc.msgSend(cls, objc.sel("new"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(view, objc.sel("setWantsLayer:"), objc.YES);

    // Register as drag destination for file URLs
    const NSArray = objc.getClass("NSArray") orelse return null;
    const fileURLType = objc.nsString("public.file-url");
    const dragTypes = objc.msgSend1(NSArray, objc.sel("arrayWithObject:"), fileURLType);
    objc.msgSendVoid1(view, objc.sel("registerForDraggedTypes:"), dragTypes);

    const layer = objc.msgSend(view, objc.sel("layer"));
    const NSColor = objc.getClass("NSColor") orelse return null;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"),
        0.059, 0.078, 0.106, 1.0);
    const cgColor = objc.msgSend(bg, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), cgColor);

    terminals[slot] = .{
        .pty = pty,
        .vterm = vterm,
        .view = view,
        .slot = slot,
    };

    registerScrollbackCallbacks(slot, &terminals[slot].?.vterm);
    registerOutputCallback(&terminals[slot].?);

    ensurePollTimer();
    return view;
}

fn registerScrollbackCallbacks(slot: usize, vterm: *VTerm) void {
    const RawCallbacks = extern struct {
        damage: ?*const anyopaque = null,
        moverect: ?*const anyopaque = null,
        movecursor: ?*const anyopaque = null,
        settermprop: ?*const anyopaque = null,
        bell: ?*const anyopaque = null,
        resize: ?*const anyopaque = null,
        sb_pushline: ?*const fn (c_int, ?*const anyopaque, ?*anyopaque) callconv(.c) c_int = null,
        sb_popline: ?*const fn (c_int, ?*anyopaque, ?*anyopaque) callconv(.c) c_int = null,
        sb_clear: ?*const anyopaque = null,
    };
    const cbs = struct {
        var callbacks: RawCallbacks = .{
            .sb_pushline = @ptrCast(&sbPushLine),
            .sb_popline = @ptrCast(&sbPopLine),
        };
    };
    vt_mod.screenSetCallbacks(vterm.screen, @ptrCast(&cbs.callbacks), @ptrCast(@alignCast(&terminals[slot].?)));
}

fn registerOutputCallback(entry: *TermEntry) void {
    const cb: *const fn ([*c]const u8, usize, ?*anyopaque) callconv(.c) void = &vtermOutputCallback;
    vt_mod.c.vterm_output_set_callback(entry.vterm.vt, cb, @ptrCast(entry));
}

fn vtermOutputCallback(s: [*c]const u8, len: usize, user: ?*anyopaque) callconv(.c) void {
    const entry: *TermEntry = @ptrCast(@alignCast(user orelse return));
    if (s == null) return;
    entry.pty.write(s[0..len]);
}

/// Destroy a specific terminal by slot index.
pub fn destroyTerminalAtSlot(slot: usize) void {
    if (slot >= MAX_TERMS) return;
    if (terminals[slot]) |*entry| {
        // Remove view from superview and release
        objc.msgSendVoid(entry.view, objc.sel("removeFromSuperview"));
        objc.msgSendVoid(entry.view, objc.sel("release"));
        entry.pty.close();
        entry.vterm.deinit();
        entry.scrollback.deinit(allocator);
        terminals[slot] = null;
    }
}

/// Destroy all terminals.
/// Destroy a session and all its terminal panes.
/// Check if a session's root terminal process is alive.
pub fn isSessionAlive(terminal_id: []const u8) bool {
    const si = findSessionByTerminalId(terminal_id) orelse return false;
    const session = sessions[si] orelse return false;
    // Check the first leaf's PTY
    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    session.root.collectLeaves(allocator, &leaves);
    if (leaves.items.len == 0) return false;
    // Check first leaf (root pane — the one with the configured command)
    if (terminals[leaves.items[0]]) |*entry| {
        return !entry.pty.hasExited();
    }
    return false;
}

pub fn destroySession(terminal_id: []const u8) void {
    const session_idx = findSessionByTerminalId(terminal_id) orelse return;
    if (sessions[session_idx]) |*session| {
        var leaves: std.ArrayListUnmanaged(usize) = .{};
        defer leaves.deinit(allocator);
        session.root.collectLeaves(allocator, &leaves);
        for (leaves.items) |slot| {
            destroyTerminalAtSlot(slot);
        }
        session.root.destroyTree(allocator);
        allocator.destroy(session.root);
        allocator.free(session.terminal_id);
        sessions[session_idx] = null;
    }
    if (active_session != null and active_session.? == session_idx) {
        active_session = null;
    }
}

pub fn destroyAllTerminals() void {
    for (&terminals) |*t| {
        if (t.*) |*entry| {
            objc.msgSendVoid(entry.view, objc.sel("removeFromSuperview"));
            objc.msgSendVoid(entry.view, objc.sel("release"));
            entry.pty.close();
            entry.vterm.deinit();
            entry.scrollback.deinit(allocator);
            t.* = null;
        }
    }
    for (&sessions) |*s| {
        if (s.*) |*session| {
            session.root.destroyTree(allocator);
            allocator.destroy(session.root);
            allocator.free(session.terminal_id);
            s.* = null;
        }
    }
    active_session = null;
}

// ---------------------------------------------------------------------------
// Custom NSView subclass
// ---------------------------------------------------------------------------

fn registerTermViewClass() ?objc.id {
    const NSView = objc.getClass("NSView") orelse return null;
    const cls = objc.allocateClassPair(NSView, "TermGridView2") orelse return null;
    _ = objc.addMethod(cls, objc.sel("drawRect:"), &drawRect, "v@:{CGRect=dddd}");
    _ = objc.addMethod(cls, objc.sel("keyDown:"), &termKeyDown, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseDown:"), &termMouseDown, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseDragged:"), &termMouseDragged, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseUp:"), &termMouseUp, "v@:@");
    _ = objc.addMethod(cls, objc.sel("scrollWheel:"), &termScrollWheel, "v@:@");
    _ = objc.addMethod(cls, objc.sel("flagsChanged:"), &termFlagsChanged, "v@:@");
    _ = objc.addMethod(cls, objc.sel("acceptsFirstResponder"), &acceptsFirst, "B@:");
    _ = objc.addMethod(cls, objc.sel("becomeFirstResponder"), &becomesFirst, "B@:");
    _ = objc.addMethod(cls, objc.sel("resignFirstResponder"), &resignsFirst, "B@:");
    _ = objc.addMethod(cls, objc.sel("isFlipped"), &isFlipped, "B@:");
    // Drag-and-drop destination
    _ = objc.addMethod(cls, objc.sel("draggingEntered:"), &termDragEntered, "Q@:@");
    _ = objc.addMethod(cls, objc.sel("performDragOperation:"), &termPerformDrag, "B@:@");
    // Font size shortcuts (⌘= ⌘- ⌘0) need deferred handling via pending_font_delta,
    // so we intercept them here before the menu system sees them.
    _ = objc.addMethod(cls, objc.sel("performKeyEquivalent:"), &termPerformKeyEquivalent, "B@:@");
    objc.registerClassPair(cls);
    return cls;
}

// ---------------------------------------------------------------------------
// Menu action responders (called via responder chain when terminal is focused)
// ---------------------------------------------------------------------------

fn termClearAction(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    clearFocusedTerminal();
}
fn termPasteAction(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    pasteFocusedTerminal();
}
fn termResetFontAction(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    resetFontSize();
}
fn termIncreaseFontAction(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    adjustFontSize(1.0);
}
fn termDecreaseFontAction(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    adjustFontSize(-1.0);
}

fn termPerformKeyEquiv(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) objc.BOOL {
    // Don't override — let everything go to the menu bar
    return objc.NO;
}

// ---------------------------------------------------------------------------
// Drag-and-drop destination
// ---------------------------------------------------------------------------

fn termDragEntered(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) objc.NSUInteger {
    return 1; // NSDragOperationCopy
}

fn termPerformDrag(self: objc.id, _: objc.SEL, sender: objc.id) callconv(.c) objc.BOOL {
    const entry = findEntry(self) orelse return objc.NO;
    const pboard = objc.msgSend(sender, objc.sel("draggingPasteboard"));

    // Get array of file URLs from pasteboard
    const NSURL = objc.getClass("NSURL") orelse return objc.NO;
    const NSArray = objc.getClass("NSArray") orelse return objc.NO;
    const urlType = objc.nsString("public.file-url");
    _ = urlType;
    const options = objc.msgSend(objc.getClass("NSDictionary") orelse return objc.NO, objc.sel("dictionary"));

    const readObjects: *const fn (objc.id, objc.SEL, objc.id, objc.id) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const urls = readObjects(pboard, objc.sel("readObjectsForClasses:options:"), 
        objc.msgSend1(NSArray, objc.sel("arrayWithObject:"), NSURL), options);

    const count = objc.msgSendUInt(urls, objc.sel("count"));
    if (count == 0) return objc.NO;

    // Build space-separated list of paths, shell-escaped
    var i: objc.NSUInteger = 0;
    var first = true;
    while (i < count) : (i += 1) {
        const url = objc.msgSend1(urls, objc.sel("objectAtIndex:"), i);
        const path_ns = objc.msgSend(url, objc.sel("path"));
        if (path_ns == objc.nil) continue;
        const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(path_ns, objc.sel("UTF8String")));
        const path = std.mem.span(utf8);
        if (path.len == 0) continue;

        if (!first) {
            entry.pty.write(" ");
        }
        first = false;

        // Shell-escape: wrap in single quotes, escape existing single quotes
        entry.pty.write("'");
        var start: usize = 0;
        for (path, 0..) |c, j| {
            if (c == '\'') {
                if (j > start) entry.pty.write(path[start..j]);
                entry.pty.write("'\\''");
                start = j + 1;
            }
        }
        if (start < path.len) entry.pty.write(path[start..]);
        entry.pty.write("'");
    }

    return objc.YES;
}

// ---------------------------------------------------------------------------
// Scrollback callbacks
// ---------------------------------------------------------------------------

fn sbPushLine(cols: c_int, cells_raw: ?*const anyopaque, user: ?*anyopaque) callconv(.c) c_int {
    const entry: *TermEntry = @ptrCast(@alignCast(user orelse return 0));
    const num_cols: u16 = @intCast(@min(@as(u16, @intCast(cols)), 512));

    // Parse raw cells into a temporary stack buffer first to find trimmed length
    var tmp_cells: [512]vt_mod.Cell = undefined;
    @memset(std.mem.sliceAsBytes(tmp_cells[0..num_cols]), 0);

    if (cells_raw) |ptr| {
        const raw_bytes: [*]const u8 = @ptrCast(ptr);
        var i: u16 = 0;
        while (i < num_cols) : (i += 1) {
            const offset = @as(usize, i) * 40;
            var raw: vt_mod.RawScreenCell = undefined;
            @memcpy(std.mem.asBytes(&raw), raw_bytes[offset..][0..40]);

            tmp_cells[i] = .{
                .chars = .{ raw.chars[0], raw.chars[1] },
                .width = if (raw.width > 0) @intCast(raw.width) else 1,
                .fg = vt_mod.decodeVTermColor(raw.fg, vt_mod.DEFAULT_FG),
                .bg = vt_mod.decodeVTermColor(raw.bg, vt_mod.DEFAULT_BG),
            };
        }
    }

    // Trim trailing empty cells (space/NUL with default colors, no attributes)
    var trimmed: u16 = num_cols;
    while (trimmed > 0) {
        const c = tmp_cells[trimmed - 1];
        const is_empty_char = (c.chars[0] == 0 or c.chars[0] == ' ') and c.chars[1] == 0;
        const is_default_fg = c.fg.r == vt_mod.DEFAULT_FG.r and c.fg.g == vt_mod.DEFAULT_FG.g and c.fg.b == vt_mod.DEFAULT_FG.b;
        const is_default_bg = c.bg.r == vt_mod.DEFAULT_BG.r and c.bg.g == vt_mod.DEFAULT_BG.g and c.bg.b == vt_mod.DEFAULT_BG.b;
        if (is_empty_char and is_default_fg and is_default_bg and !c.bold and !c.italic and !c.underline and !c.reverse) {
            trimmed -= 1;
        } else break;
    }

    // Allocate only the trimmed cells
    const store_len = if (trimmed > 0) trimmed else 1; // keep at least 1 for empty lines
    const cells = allocator.alloc(vt_mod.Cell, store_len) catch return 0;
    @memcpy(cells, tmp_cells[0..store_len]);

    const line = ScrollLine{ .cells = cells, .len = num_cols };
    entry.scrollback.append(allocator, line);

    // If user is scrolled back, adjust offset to keep viewport stable
    if (entry.scroll_offset < 0) {
        entry.scroll_offset -= 1;
    }

    return 1;
}

fn sbPopLine(_: c_int, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) c_int {
    // Always return 0 (no lines to restore). Scrollback viewing still works
    // via our own scroll_offset mechanism. Returning 1 without perfectly
    // filling the VTermScreenCell buffer causes vterm_set_size to hang.
    // TODO: properly fill the VTermScreenCell buffer from scrollback data
    // so lines are restored when the terminal grows.
    return 0;
}

fn acceptsFirst(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }
fn becomesFirst(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }
fn resignsFirst(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL {
    // Cancel any active speech session when terminal loses focus
    speech_indicator.cancel();
    return objc.YES;
}
fn isFlipped(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }

// Push-to-talk speech recognition — delegates to speech_indicator module
const speech_indicator = @import("speech_indicator.zig");

fn termFlagsChanged(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    speech_indicator.handleFlagsChanged(self, event, struct {
        fn write(text: []const u8) void {
            // Find focused terminal and write transcription to its PTY
            const si = active_session orelse return;
            if (si >= MAX_TERMS) return;
            const session = sessions[si] orelse return;
            if (session.focused_slot < MAX_TERMS) {
                if (terminals[session.focused_slot]) |*entry| {
                    entry.pty.write(text);
                }
            }
        }
    }.write);
}

fn termScrollWheel(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    const entry = findEntry(self) orelse return;

    const scrollingDeltaY: *const fn (objc.id, objc.SEL) callconv(.c) objc.CGFloat =
        @ptrCast(&objc.c.objc_msgSend);
    const delta = scrollingDeltaY(event, objc.sel("scrollingDeltaY"));

    // scrollingDeltaY already respects macOS natural scrolling preference.
    // Positive delta = finger moves down = scroll toward newer content (scroll_offset toward 0)
    // Negative delta = finger moves up = scroll toward older content (scroll_offset more negative)
    const lines: i32 = @intFromFloat(delta / 3.0);
    if (lines == 0) return;

    const sb_len: i32 = @intCast(entry.scrollback.len());
    entry.scroll_offset = @min(0, @max(-sb_len, entry.scroll_offset - lines));

    // Trigger redraw
    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(self, objc.sel("setNeedsDisplay:"), objc.YES);
}

fn termMouseDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    // Get click location in the main panel's coordinate space
    const panel = @import("window.zig").main_panel_view orelse return;
    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const loc = convertPoint(panel, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);

    // Check if click is on a divider
    for (dividers[0..divider_count]) |maybe_div| {
        const div = maybe_div orelse continue;
        if (loc.x >= div.rect.origin.x and loc.x <= div.rect.origin.x + div.rect.size.width and
            loc.y >= div.rect.origin.y and loc.y <= div.rect.origin.y + div.rect.size.height)
        {
            // Start divider drag
            dragging_divider = div.node;
            drag_direction = div.node.split.direction;
            drag_start_ratio = div.node.split.ratio;
            if (drag_direction == .horizontal) {
                drag_origin = loc.x;
                drag_total_size = div.rect.size.height; // will recalc from parent
            } else {
                drag_origin = loc.y;
            }
            // Calculate total size from panel bounds
            const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
            drag_total_size = if (drag_direction == .horizontal) bounds.size.width else bounds.size.height;
            return;
        }
    }

    // Not a divider click — focus this pane and start selection
    const win = objc.msgSend(self, objc.sel("window"));
    objc.msgSendVoid1(win, objc.sel("makeFirstResponder:"), self);

    const entry_found = findEntry(self) orelse return;
    const session_idx = active_session orelse return;
    if (session_idx < MAX_TERMS) {
        if (sessions[session_idx]) |*session| {
            session.focused_slot = entry_found.slot;
            // Don't call layoutActiveSession here — it would destroy this view
            // and break mouse drag tracking. Just update the focus borders.
            updateFocusBorders(session);
        }
    }

    // Start text selection
    const view_loc = viewLocFromEvent(self, event);
    const grid_pos = pixelToGrid(view_loc, entry_found.scroll_offset);
    entry_found.selection = .{
        .active = true,
        .start_col = grid_pos.col,
        .start_row = grid_pos.row,
        .end_col = grid_pos.col,
        .end_row = grid_pos.row,
    };
    const setBool2: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool2(self, objc.sel("setNeedsDisplay:"), objc.YES);
}

fn termMouseDragged(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    // Extend selection
    if (findEntry(self)) |entry| {
        if (entry.selection.active) {
            const view_loc = viewLocFromEvent(self, event);
            const grid_pos = pixelToGrid(view_loc, entry.scroll_offset);
            entry.selection.end_col = grid_pos.col;
            entry.selection.end_row = grid_pos.row;
            const setBool2: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setBool2(self, objc.sel("setNeedsDisplay:"), objc.YES);
            return;
        }
    }

    const div_node = dragging_divider orelse return;
    const panel = @import("window.zig").main_panel_view orelse return;

    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const loc = convertPoint(panel, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);

    const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
    const total = if (div_node.split.direction == .horizontal) bounds.size.width else bounds.size.height;

    if (total <= 0) return;

    const current_pos = if (div_node.split.direction == .horizontal) loc.x else loc.y;
    const delta = current_pos - drag_origin;

    // For vertical splits, y is inverted (macOS y=0 at bottom, first=top=higher y)
    const ratio_delta = if (div_node.split.direction == .vertical) -delta / total else delta / total;

    const new_ratio = @max(0.1, @min(0.9, drag_start_ratio + ratio_delta));
    div_node.split.ratio = new_ratio;

    layoutActiveSession(panel);
}

fn termMouseUp(self: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    if (dragging_divider != null) {
        dragging_divider = null;
        saveSplitState(); // Persist new ratio
        // Re-focus the focused pane after divider drag
        if (getFocusedView()) |focused_view| {
            const win = objc.msgSend(focused_view, objc.sel("window"));
            if (@intFromPtr(win) != 0) {
                objc.msgSendVoid1(win, objc.sel("makeFirstResponder:"), focused_view);
            }
        }
        return;
    }

    // Copy selection to clipboard only if there's a real selection (not just a click)
    if (findEntry(self)) |entry| {
        if (entry.selection.active) {
            const s = entry.selection.ordered();
            const has_selection = s.r1 != s.r2 or s.c1 != s.c2;
            if (has_selection) {
                copySelectionToClipboard(entry);
                // Clear selection after copying
                entry.selection.active = false;
                const setBool3: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setBool3(self, objc.sel("setNeedsDisplay:"), objc.YES);
            } else {
                // Plain click — clear selection
                entry.selection.active = false;
                const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setBool(self, objc.sel("setNeedsDisplay:"), objc.YES);
            }
        }
    }
}

fn viewLocFromEvent(view: objc.id, event: objc.id) objc.NSPoint {
    const loc_in_window = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    return convertPoint(view, objc.sel("convertPoint:fromView:"), loc_in_window.origin, null);
}

fn pixelToGrid(loc: objc.NSPoint, scroll_offset: i32) struct { row: i32, col: u16 } {
    const col_f = loc.x / cell_width;
    const row_f = loc.y / cell_height;
    const col: u16 = @intFromFloat(@max(col_f, 0));
    const row: i32 = @intFromFloat(@max(row_f, 0));
    return .{ .row = row + scroll_offset, .col = col };
}

fn copySelectionToClipboard(entry: *TermEntry) void {
    const sel = entry.selection;
    if (!sel.active) return;
    const s = sel.ordered();

    // Build the selected text
    var text_buf: [65536]u8 = undefined;
    var text_len: usize = 0;
    const sb_len: i32 = @intCast(entry.scrollback.len());

    var row = s.r1;
    while (row <= s.r2) : (row += 1) {
        const start_col: u16 = if (row == s.r1) s.c1 else 0;
        const end_col: u16 = if (row == s.r2) s.c2 else entry.vterm.cols - 1;

        const row_start = text_len;
        var col = start_col;
        while (col <= end_col) : (col += 1) {
            var cell_val: vt_mod.Cell = undefined;
            if (row < 0) {
                const sb_idx = sb_len + row;
                if (sb_idx >= 0 and sb_idx < sb_len) {
                    const line = entry.scrollback.get(@intCast(sb_idx));
                    cell_val = if (col < line.cells.len) line.cells[col] else .{};
                } else cell_val = .{};
            } else {
                cell_val = entry.vterm.getCell(@intCast(row), col);
            }

            const ch = cell_val.chars[0];
            if (ch > 0 and ch <= 0x10FFFF) {
                if (text_len + 4 <= text_buf.len) {
                    const enc_len = std.unicode.utf8Encode(@intCast(ch), text_buf[text_len..][0..4]) catch 0;
                    if (enc_len > 0) text_len += enc_len;
                }
            } else {
                if (text_len < text_buf.len) {
                    text_buf[text_len] = ' ';
                    text_len += 1;
                }
            }
        }

        // Trim trailing spaces from this row
        while (text_len > row_start and text_buf[text_len - 1] == ' ') {
            text_len -= 1;
        }

        // Add newline between rows (but not after the last)
        if (row < s.r2 and text_len < text_buf.len) {
            text_buf[text_len] = '\n';
            text_len += 1;
        }
    }

    if (text_len == 0) return;

    // Copy to clipboard using setString:forType:
    const NSPasteboard = objc.getClass("NSPasteboard") orelse return;
    const pb = objc.msgSend(NSPasteboard, objc.sel("generalPasteboard"));
    objc.msgSendVoid(pb, objc.sel("clearContents"));

    const NSString = objc.getClass("NSString") orelse return;
    const initWithBytes: *const fn (objc.id, objc.SEL, [*]const u8, objc.NSUInteger, objc.NSUInteger) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const ns_str = initWithBytes(
        objc.msgSend(NSString, objc.sel("alloc")),
        objc.sel("initWithBytes:length:encoding:"),
        &text_buf, text_len, 4,
    );

    // NSPasteboardTypeString
    const pb_type = objc.nsString("public.utf8-plain-text");
    objc.msgSendVoid2(pb, objc.sel("setString:forType:"), ns_str, pb_type);

    // Show toast
    showCopiedToast(entry.view);
}

var toast_view: ?objc.id = null;
var toast_timer: ?objc.id = null;
var toast_helper_class: ?objc.id = null;

fn showCopiedToast(term_view: objc.id) void {
    // Remove existing toast
    if (toast_view) |tv| {
        objc.msgSendVoid(tv, objc.sel("removeFromSuperview"));
        toast_view = null;
    }

    const NSView = objc.getClass("NSView") orelse return;
    const NSTextField = objc.getClass("NSTextField") orelse return;

    const toast = objc.msgSend(NSView, objc.sel("new"));
    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    // Position toast at center of the main panel
    const window_ui = @import("window.zig");
    const panel = window_ui.main_panel_view orelse term_view;
    const bounds = objc.msgSendRect(panel, objc.sel("bounds"));
    const toast_w: f64 = 200;
    const toast_h: f64 = 36;
    const toast_x = (bounds.size.width - toast_w) / 2;
    const toast_y = (bounds.size.height - toast_h) / 2;
    setFrame(toast, objc.sel("setFrame:"), objc.NSMakeRect(toast_x, toast_y, toast_w, toast_h));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(toast, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(toast, objc.sel("layer"));
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.25, 0.32, 1.0);
    const cgColor = objc.msgSend(bg, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), cgColor);
    const setCornerRadius: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setCornerRadius(layer, objc.sel("setCornerRadius:"), 6.0);

    // Label
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Copied to clipboard"));
    setFrame(label, objc.sel("setFrame:"), objc.NSMakeRect(0, 10, toast_w, 16));

    const NSFont = objc.getClass("NSFont") orelse return;
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(label, objc.sel("setFont:"), sysFont(NSFont, objc.sel("boldSystemFontOfSize:"), 13.0));

    const fg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.85, 0.9, 0.95, 1.0);
    objc.msgSendVoid1(label, objc.sel("setTextColor:"), fg);

    const setAlign: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlign(label, objc.sel("setAlignment:"), 1); // NSTextAlignmentCenter

    objc.msgSendVoid1(toast, objc.sel("addSubview:"), label);
    objc.msgSendVoid1(panel, objc.sel("addSubview:"), toast);
    toast_view = toast;

    // Set timer to remove toast after 1.5 seconds
    if (toast_helper_class == null) {
        const NSObject = objc.getClass("NSObject") orelse return;
        const cls = objc.allocateClassPair(NSObject, "ToastHelper") orelse return;
        _ = objc.addMethod(cls, objc.sel("hideToast:"), &hideToast, "v@:@");
        objc.registerClassPair(cls);
        toast_helper_class = cls;
    }
    const helper = objc.msgSend(toast_helper_class.?, objc.sel("new"));

    const NSTimer = objc.getClass("NSTimer") orelse return;
    const timerFn: *const fn (objc.id, objc.SEL, f64, ?*anyopaque, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    toast_timer = timerFn(NSTimer,
        objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        1.5, helper, objc.sel("hideToast:"), null, objc.NO);
}

fn hideToast(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    if (toast_view) |tv| {
        objc.msgSendVoid(tv, objc.sel("removeFromSuperview"));
        toast_view = null;
    }
    toast_timer = null;
}

fn pasteFromClipboard(entry: *TermEntry) void {
    const NSPasteboard = objc.getClass("NSPasteboard") orelse return;
    const pb = objc.msgSend(NSPasteboard, objc.sel("generalPasteboard"));
    const pb_type = objc.nsString("public.utf8-plain-text");
    const ns_str = objc.msgSend1(pb, objc.sel("stringForType:"), pb_type);
    if (@intFromPtr(ns_str) == 0) return; // nil check

    const utf8_ptr = objc.msgSend(ns_str, objc.sel("UTF8String"));
    if (@intFromPtr(utf8_ptr) == 0) return; // nil check
    const utf8: [*:0]const u8 = @ptrCast(utf8_ptr);
    const str = std.mem.span(utf8);
    if (str.len > 0) {
        entry.pty.write("\x1b[200~");
        entry.pty.write(str);
        entry.pty.write("\x1b[201~");
    }
}

pub fn pasteFocusedTerminal() void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = sessions[session_idx] orelse return;
    if (terminals[session.focused_slot]) |*entry| {
        pasteFromClipboard(entry);
    }
}

pub fn resetFontSize() void {
    font_size = 13.0;
    cached_font = null;
    updateCellMetrics();
    resizeAllTerminals();
    saveFontSize();
}

pub fn clearFocusedTerminal() void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = sessions[session_idx] orelse return;
    if (terminals[session.focused_slot]) |*entry| {
        // Clear scrollback
        entry.scroll_offset = 0;
        entry.scrollback.clearRetainingCapacity(allocator);
        // Clear vterm screen
        entry.vterm.feed("\x1b[2J\x1b[H");
        // Send Ctrl+L to the shell so it redraws the prompt
        entry.pty.write("\x0c");
        const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setBool(entry.view, objc.sel("setNeedsDisplay:"), objc.YES);
    }
}

pub var pending_font_delta: f64 = 0;
pub var pending_font_reset: bool = false;

pub fn adjustFontSize(delta: f64) void {
    changeFontSize(delta);
    resizeAllTerminals();
    saveFontSize();
}

fn changeFontSize(delta: f64) void {
    font_size = @max(8.0, @min(36.0, font_size + delta));
    cached_font = null; // invalidate cache
    updateCellMetrics();
}

fn saveFontSize() void {
    const home = std.posix.getenv("HOME") orelse return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/Library/Application Support/stacks/settings.json", .{home}) catch return;
    var file = std.fs.createFileAbsolute(path, .{}) catch return;
    defer file.close();
    var buf: [64]u8 = undefined;
    const json = std.fmt.bufPrint(&buf, "{{\"font_size\":{d:.1}}}\n", .{font_size}) catch return;
    file.writeAll(json) catch {};
}

pub fn loadFontSize() void {
    const home = std.posix.getenv("HOME") orelse return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/Library/Application Support/stacks/settings.json", .{home}) catch return;
    const file = std.fs.openFileAbsolute(path, .{}) catch return;
    defer file.close();
    var buf: [256]u8 = undefined;
    const n = file.readAll(&buf) catch return;
    const content = buf[0..n];
    // Simple parse: find "font_size": followed by a number
    if (std.mem.indexOf(u8, content, "\"font_size\":")) |idx| {
        const after = content[idx + 12 ..];
        const size = std.fmt.parseFloat(f64, std.mem.trim(u8, after[0..@min(after.len, 10)], " \t\n\r}")) catch return;
        if (size >= 8.0 and size <= 36.0) {
            font_size = size;
            cached_font = null;
            updateCellMetrics();
        }
    }
}

fn resizeAllTerminals() void {
    for (&terminals) |*t| {
        if (t.*) |*entry| {
            syncTermSize(entry);
            const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setBool(entry.view, objc.sel("setNeedsDisplay:"), objc.YES);
        }
    }
}

fn syncTermSize(entry: *TermEntry) void {
    const bounds = objc.msgSendRect(entry.view, objc.sel("bounds"));
    if (bounds.size.width < 1 or bounds.size.height < 1) return;

    // Account for focus border, scrollbar overlap, and rounding
    const usable_w = bounds.size.width - 14;
    const usable_h = bounds.size.height - 4;
    const new_cols: u16 = @intFromFloat(@max(@floor(usable_w / cell_width), 1));
    const new_rows: u16 = @intFromFloat(@max(@floor(usable_h / cell_height), 1));

    if (new_cols != entry.vterm.cols or new_rows != entry.vterm.rows) {
        entry.vterm.resize(new_rows, new_cols);
        entry.pty.resize(new_cols, new_rows);
    }
}

fn findEntry(view: objc.id) ?*TermEntry {
    for (&terminals) |*t| {
        if (t.*) |*e| {
            if (e.view == view) return e;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

fn drawRect(self: objc.id, _: objc.SEL, _: objc.NSRect) callconv(.c) void {
    // Wrap in autorelease pool to prevent ObjC object leaks
    const NSAutoreleasePool = objc.getClass("NSAutoreleasePool") orelse return;
    const pool = objc.msgSend(NSAutoreleasePool, objc.sel("new"));
    defer objc.msgSendVoid(pool, objc.sel("drain"));

    const entry = findEntry(self) orelse return;

    // Get current graphics context
    const NSGraphicsContext = objc.getClass("NSGraphicsContext") orelse return;
    const ctx_wrapper = objc.msgSend(NSGraphicsContext, objc.sel("currentContext"));
    const cgctx = objc.msgSend(ctx_wrapper, objc.sel("CGContext"));

    // Clip to view bounds so nothing draws outside
    const CG_clip = struct {
        extern "CoreGraphics" fn CGContextClipToRect(ctx: *anyopaque, rect: objc.NSRect) void;
    };
    const view_bounds = objc.msgSendRect(self, objc.sel("bounds"));
    CG_clip.CGContextClipToRect(cgctx, view_bounds);

    const font = getCachedFont();

    // Get CoreGraphics function pointers
    const CG = struct {
        extern "CoreGraphics" fn CGContextSetRGBFillColor(ctx: *anyopaque, r: f64, g: f64, b: f64, a: f64) void;
        extern "CoreGraphics" fn CGContextFillRect(ctx: *anyopaque, rect: objc.NSRect) void;
        extern "CoreGraphics" fn CGContextSetRGBStrokeColor(ctx: *anyopaque, r: f64, g: f64, b: f64, a: f64) void;
        extern "CoreGraphics" fn CGContextSaveGState(ctx: *anyopaque) void;
        extern "CoreGraphics" fn CGContextRestoreGState(ctx: *anyopaque) void;
        extern "CoreGraphics" fn CGContextTranslateCTM(ctx: *anyopaque, tx: f64, ty: f64) void;
        extern "CoreGraphics" fn CGContextScaleCTM(ctx: *anyopaque, sx: f64, sy: f64) void;
        extern "CoreGraphics" fn CGContextSetTextPosition(ctx: *anyopaque, x: f64, y: f64) void;
    };

    const getFloat: *const fn (objc.id, objc.SEL) callconv(.c) objc.CGFloat =
        @ptrCast(&objc.c.objc_msgSend);

    const cursor = entry.vterm.getCursor();
    const sb_len: i32 = @intCast(entry.scrollback.len());
    // scroll_offset: 0 = at bottom (showing live grid), negative = scrolled up
    const scroll_off = entry.scroll_offset;

    var row: u16 = 0;
    while (row < entry.vterm.rows) : (row += 1) {
        // Which logical line does this screen row map to?
        // With scroll_off=0, row 0 maps to grid row 0.
        // With scroll_off=-5, row 0 maps to scrollback[-5], row 4 maps to scrollback[-1],
        // row 5 maps to grid row 0, etc.
        const logical_row: i32 = @as(i32, @intCast(row)) + scroll_off;
        // logical_row < 0 means scrollback, >= 0 means active grid
        const grid_row_i: i32 = logical_row;

        var col: u16 = 0;
        while (col < entry.vterm.cols) {
            defer col += 1;
            var cell: vt_mod.Cell = undefined;

            if (grid_row_i < 0) {
                // Scrollback line
                const sb_idx = sb_len + grid_row_i;
                if (sb_idx >= 0 and sb_idx < sb_len) {
                    const line = entry.scrollback.get(@intCast(sb_idx));
                    if (col < line.cells.len) {
                        cell = line.cells[col];
                    } else {
                        cell = .{};
                    }
                } else {
                    cell = .{};
                }
            } else {
                // Active grid
                cell = entry.vterm.getCell(@intCast(grid_row_i), col);
            }

            const x: f64 = @as(f64, @floatFromInt(col)) * cell_width;
            const y: f64 = @as(f64, @floatFromInt(row)) * cell_height;
            const char_w = cell_width * @as(f64, @floatFromInt(cell.width));

            var fg = cell.fg;
            var bg_color = cell.bg;
            if (cell.reverse) {
                const tmp = fg;
                fg = bg_color;
                bg_color = tmp;
            }

            // Draw background spanning full cell width (including wide chars)
            // Check if this cell is in the selection
            const is_selected = entry.selection.contains(grid_row_i, col);
            if (is_selected) {
                // Selection highlight color
                CG.CGContextSetRGBFillColor(cgctx, 0.2, 0.35, 0.55, 1.0);
                fg = .{ .r = 255, .g = 255, .b = 255 };
            } else {
                const bg_r: f64 = @as(f64, @floatFromInt(bg_color.r)) / 255.0;
                const bg_g: f64 = @as(f64, @floatFromInt(bg_color.g)) / 255.0;
                const bg_b: f64 = @as(f64, @floatFromInt(bg_color.b)) / 255.0;
                CG.CGContextSetRGBFillColor(cgctx, bg_r, bg_g, bg_b, 1.0);
            }
            CG.CGContextFillRect(cgctx, objc.NSMakeRect(x, y, char_w, cell_height));

            // Draw cursor (only on active grid, not scrollback)
            if (scroll_off == 0 and grid_row_i >= 0 and @as(u16, @intCast(grid_row_i)) == cursor.row and col == cursor.col) {
                CG.CGContextSetRGBFillColor(cgctx, 0.8, 0.8, 0.8, 1.0);
                CG.CGContextFillRect(cgctx, objc.NSMakeRect(x, y, char_w, cell_height));
                fg = vt_mod.DEFAULT_BG;
            }

            // Skip continuation cells of wide characters
            if (cell.width > 1) {
                col += cell.width - 1;
            }
        }

        // Build the entire row as one attributed string and draw as CTLine
        const CT = struct {
            extern "CoreText" fn CTLineCreateWithAttributedString(attrString: *anyopaque) *anyopaque;
            extern "CoreText" fn CTLineDraw(line: *anyopaque, context: *anyopaque) void;
            extern "CoreFoundation" fn CFRelease(cf: *anyopaque) void;
        };

        const NSColor = objc.getClass("NSColor") orelse continue;
        const colorFn: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);

        // Build UTF-8 row string and per-cell color info with UTF-16 lengths
        var row_buf: [4096]u8 = undefined;
        var row_len: usize = 0;

        const ColorRun = struct { fg: vt_mod.Color, utf16_len: u8 };
        var color_runs: [512]ColorRun = undefined;
        var run_count: usize = 0;

        var c2: u16 = 0;
        while (c2 < entry.vterm.cols) : (c2 += 1) {
            var cell2: vt_mod.Cell = undefined;
            if (grid_row_i < 0) {
                const sb_idx2 = sb_len + grid_row_i;
                if (sb_idx2 >= 0 and sb_idx2 < sb_len) {
                    const line2 = entry.scrollback.get(@intCast(sb_idx2));
                    cell2 = if (c2 < line2.cells.len) line2.cells[c2] else .{};
                } else cell2 = .{};
            } else {
                cell2 = entry.vterm.getCell(@intCast(grid_row_i), c2);
            }

            var fg2 = cell2.fg;
            if (cell2.reverse) fg2 = cell2.bg;
            if (scroll_off == 0 and grid_row_i >= 0 and @as(u16, @intCast(grid_row_i)) == cursor.row and c2 == cursor.col)
                fg2 = vt_mod.DEFAULT_BG;

            const ch = cell2.chars[0];
            var utf16_len: u8 = 1; // most characters are 1 UTF-16 code unit

            // Skip continuation cells of wide characters (width == 0 means
            // this cell is the trailing half of a wide char drawn in the previous cell)
            if (cell2.width == 0) {
                // Emit a space placeholder so column positions stay aligned
                if (row_len < row_buf.len) {
                    row_buf[row_len] = ' ';
                    row_len += 1;
                }
                if (run_count < 512) {
                    color_runs[run_count] = .{ .fg = fg2, .utf16_len = 1 };
                    run_count += 1;
                }
                continue;
            }

            // Wide characters (emoji, CJK) and box-drawing chars are replaced with
            // spaces in the row string. Wide chars are drawn individually at grid
            // positions afterward (CoreText doesn't respect monospace grid for emoji).
            const is_box = box_drawing.isBoxDrawing(ch);
            const is_wide = cell2.width > 1;
            if (!is_box and !is_wide and ch > 0 and ch <= 0x10FFFF) {
                if (ch > 0xFFFF) utf16_len = 2; // surrogate pair
                if (row_len + 4 <= row_buf.len) {
                    const enc_len = std.unicode.utf8Encode(@intCast(ch), row_buf[row_len..][0..4]) catch 0;
                    if (enc_len > 0) {
                        row_len += enc_len;
                    } else {
                        row_buf[row_len] = ' ';
                        row_len += 1;
                        utf16_len = 1;
                    }
                }
            } else {
                if (row_len < row_buf.len) {
                    row_buf[row_len] = ' ';
                    row_len += 1;
                }
                utf16_len = 1;
            }
            if (run_count < 512) {
                color_runs[run_count] = .{ .fg = fg2, .utf16_len = utf16_len };
                run_count += 1;
            }
        }

        if (row_len == 0) continue;

        const NSString = objc.getClass("NSString") orelse continue;
        const initWithBytes: *const fn (objc.id, objc.SEL, [*]const u8, objc.NSUInteger, objc.NSUInteger) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const row_nsstr = objc.msgSend(initWithBytes(
            objc.msgSend(NSString, objc.sel("alloc")),
            objc.sel("initWithBytes:length:encoding:"),
            &row_buf, row_len, 4,
        ), objc.sel("autorelease"));

        const NSMutableAS = objc.getClass("NSMutableAttributedString") orelse continue;
        const astr = objc.msgSend(objc.msgSend1(
            objc.msgSend(NSMutableAS, objc.sel("alloc")),
            objc.sel("initWithString:"),
            row_nsstr,
        ), objc.sel("autorelease"));

        const full_len = objc.msgSendUInt(astr, objc.sel("length"));
        const addAttr: *const fn (objc.id, objc.SEL, objc.id, objc.id, objc.NSRange) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);

        // Set monospace font on entire row
        addAttr(astr, objc.sel("addAttribute:value:range:"),
            getCachedNSFontKey(), font, .{ .location = 0, .length = full_len });

        // Set per-character foreground color using correct UTF-16 offsets
        var utf16_pos: objc.NSUInteger = 0;
        var ri: usize = 0;
        while (ri < run_count and utf16_pos < full_len) : (ri += 1) {
            const run = color_runs[ri];
            const fc = run.fg;
            const run_len: objc.NSUInteger = run.utf16_len;
            if (utf16_pos + run_len > full_len) break;
            const fg_obj = colorFn(NSColor, objc.sel("colorWithRed:green:blue:alpha:"),
                @as(f64, @floatFromInt(fc.r)) / 255.0,
                @as(f64, @floatFromInt(fc.g)) / 255.0,
                @as(f64, @floatFromInt(fc.b)) / 255.0, 1.0);
            addAttr(astr, objc.sel("addAttribute:value:range:"),
                getCachedNSColorKey(), fg_obj, .{ .location = utf16_pos, .length = run_len });
            utf16_pos += run_len;
        }

        // Use fixedPitchFontOfSize to force monospace rendering
        const fixedFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        _ = fixedFont;

        // Draw as a single CTLine — the monospace font ensures even spacing
        const row_y: f64 = @as(f64, @floatFromInt(row)) * cell_height;
        const ct_line = CT.CTLineCreateWithAttributedString(@ptrCast(astr));
        defer CT.CFRelease(ct_line);

        CG.CGContextSaveGState(cgctx);
        CG.CGContextTranslateCTM(cgctx, 0, row_y + cell_height);
        CG.CGContextScaleCTM(cgctx, 1.0, -1.0);
        const baseline_offset = @abs(getFloat(font, objc.sel("descender")));
        CG.CGContextSetTextPosition(cgctx, 0, baseline_offset);
        CT.CTLineDraw(ct_line, cgctx);
        CG.CGContextRestoreGState(cgctx);

        // Overdraw box-drawing characters (U+2500–U+257F) with CG lines
        // because font glyphs don't fill the cell, leaving gaps.
        drawBoxDrawingChars(cgctx, entry, grid_row_i, sb_len, row, CG);

        // Draw wide characters (emoji, CJK) individually at grid positions.
        // These were replaced with spaces in the CTLine to prevent misalignment.
        drawWideChars(cgctx, entry, grid_row_i, sb_len, row, CG);
    }
}

/// Draw wide characters (emoji, CJK) individually at their grid positions.
/// These are excluded from the row CTLine to prevent column misalignment.
fn drawWideChars(
    cgctx: *anyopaque,
    entry: *TermEntry,
    grid_row_i: i32,
    sb_len: i32,
    row: u16,
    CG: anytype,
) void {
    const CT = struct {
        extern "CoreText" fn CTLineCreateWithAttributedString(attrString: *anyopaque) *anyopaque;
        extern "CoreText" fn CTLineDraw(line: *anyopaque, context: *anyopaque) void;
        extern "CoreFoundation" fn CFRelease(cf: *anyopaque) void;
    };

    var col: u16 = 0;
    while (col < entry.vterm.cols) : (col += 1) {
        var cell: vt_mod.Cell = undefined;
        if (grid_row_i < 0) {
            const sb_idx = sb_len + grid_row_i;
            if (sb_idx >= 0 and sb_idx < sb_len) {
                const line = entry.scrollback.get(@intCast(sb_idx));
                cell = if (col < line.cells.len) line.cells[col] else .{};
            } else cell = .{};
        } else {
            cell = entry.vterm.getCell(@intCast(grid_row_i), col);
        }

        if (cell.width <= 1) continue;
        const ch = cell.chars[0];
        if (ch == 0 or ch > 0x10FFFF) continue;

        // Encode the character
        var char_buf: [8]u8 = undefined;
        var char_len: usize = 0;

        // Encode the primary character
        const enc_len = std.unicode.utf8Encode(@intCast(ch), char_buf[0..4]) catch 0;
        if (enc_len == 0) continue;
        char_len = enc_len;

        // Also encode variation selectors and combining marks from chars[1..]
        for (cell.chars[1..]) |extra| {
            if (extra == 0) break;
            if (char_len + 4 <= char_buf.len) {
                const extra_len = std.unicode.utf8Encode(@intCast(extra), char_buf[char_len..][0..4]) catch 0;
                char_len += extra_len;
            }
        }

        // Create attributed string for this character
        const NSString = objc.getClass("NSString") orelse continue;
        const NSMutableAttributedString = objc.getClass("NSMutableAttributedString") orelse continue;

        const initWithBytes: *const fn (objc.id, objc.SEL, [*]const u8, objc.NSUInteger, objc.NSUInteger) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const ns_str = initWithBytes(
            objc.msgSend(NSString, objc.sel("alloc")),
            objc.sel("initWithBytes:length:encoding:"),
            &char_buf, char_len, 4, // NSUTF8StringEncoding = 4
        );

        const attr_str = objc.msgSend1(
            objc.msgSend(NSMutableAttributedString, objc.sel("alloc")),
            objc.sel("initWithString:"),
            ns_str,
        );

        // Set font
        const font = getCachedFont();
        const range_end: objc.NSUInteger = objc.msgSendUInt(attr_str, objc.sel("length"));
        const addAttr: *const fn (objc.id, objc.SEL, objc.id, objc.id, objc.NSRange) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        addAttr(attr_str, objc.sel("addAttribute:value:range:"), getCachedNSFontKey(), font, .{ .location = 0, .length = range_end });

        // Set foreground color
        var fg = cell.fg;
        if (cell.reverse) fg = cell.bg;
        const NSColor = objc.getClass("NSColor") orelse continue;
        const colorWithRGBA: *const fn (objc.id, objc.SEL, f64, f64, f64, f64) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const fg_color = colorWithRGBA(NSColor, objc.sel("colorWithRed:green:blue:alpha:"),
            @as(f64, @floatFromInt(fg.r)) / 255.0,
            @as(f64, @floatFromInt(fg.g)) / 255.0,
            @as(f64, @floatFromInt(fg.b)) / 255.0, 1.0);
        addAttr(attr_str, objc.sel("addAttribute:value:range:"), getCachedNSColorKey(), fg_color, .{ .location = 0, .length = range_end });

        // Draw at grid position
        const x: f64 = @as(f64, @floatFromInt(col)) * cell_width;
        const y: f64 = @as(f64, @floatFromInt(row + 1)) * cell_height - 3.0; // baseline
        CG.CGContextSetTextPosition(cgctx, x, y);

        const ct_line = CT.CTLineCreateWithAttributedString(@ptrCast(attr_str));
        CT.CTLineDraw(ct_line, cgctx);
        CT.CFRelease(ct_line);

        // Skip continuation cells
        col += cell.width - 1;
    }
}

/// Draw box-drawing characters (U+2500–U+257F) using CoreGraphics lines.
/// Each character is defined by which edges it connects to: right, left, down, up.
fn drawBoxDrawingChars(
    cgctx: *anyopaque,
    entry: *TermEntry,
    grid_row_i: i32,
    sb_len: i32,
    row: u16,
    CG: anytype,
) void {
    var col: u16 = 0;
    while (col < entry.vterm.cols) : (col += 1) {
        var cell: vt_mod.Cell = undefined;
        if (grid_row_i < 0) {
            const sb_idx = sb_len + grid_row_i;
            if (sb_idx >= 0 and sb_idx < sb_len) {
                const line = entry.scrollback.get(@intCast(sb_idx));
                cell = if (col < line.cells.len) line.cells[col] else .{};
            } else cell = .{};
        } else {
            cell = entry.vterm.getCell(@intCast(grid_row_i), col);
        }

        const ch = cell.chars[0];
        if (ch < 0x2500 or ch > 0x257F) continue;

        // Determine which directions this box char connects
        const info = box_drawing.getInfo(ch) orelse continue;

        var fg = cell.fg;
        if (cell.reverse) fg = cell.bg;

        const fg_r: f64 = @as(f64, @floatFromInt(fg.r)) / 255.0;
        const fg_g: f64 = @as(f64, @floatFromInt(fg.g)) / 255.0;
        const fg_b: f64 = @as(f64, @floatFromInt(fg.b)) / 255.0;
        CG.CGContextSetRGBFillColor(cgctx, fg_r, fg_g, fg_b, 1.0);
        CG.CGContextSetRGBStrokeColor(cgctx, fg_r, fg_g, fg_b, 1.0);

        const x: f64 = @as(f64, @floatFromInt(col)) * cell_width;
        const y: f64 = @as(f64, @floatFromInt(row)) * cell_height;
        const cx = @floor(x + cell_width / 2.0);
        const cy = @floor(y + cell_height / 2.0);
        const thick: f64 = if (info.heavy) 2.0 else 1.0;

        // Use filled rectangles instead of stroked lines — no anti-aliasing gaps
        CG.CGContextSetRGBFillColor(cgctx, fg_r, fg_g, fg_b, 1.0);

        if (info.right) { // center to right edge
            CG.CGContextFillRect(cgctx, objc.NSMakeRect(cx, cy, x + cell_width - cx, thick));
        }
        if (info.left) { // left edge to center
            CG.CGContextFillRect(cgctx, objc.NSMakeRect(x, cy, cx - x + thick, thick));
        }
        if (info.down) { // center to bottom edge
            CG.CGContextFillRect(cgctx, objc.NSMakeRect(cx, cy, thick, y + cell_height - cy));
        }
        if (info.up) { // top edge to center
            CG.CGContextFillRect(cgctx, objc.NSMakeRect(cx, y, thick, cy - y + thick));
        }
    }
}

// BoxInfo and boxDrawingInfo moved to box_drawing.zig

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

fn termPerformKeyEquivalent(_: objc.id, _: objc.SEL, event: objc.id) callconv(.c) objc.BOOL {
    const modifierFlags: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSUInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const flags = modifierFlags(event, objc.sel("modifierFlags"));
    const has_cmd = (flags & (1 << 20)) != 0;
    if (!has_cmd) return objc.NO;
    const has_shift = (flags & (1 << 17)) != 0;
    if (has_shift) return objc.NO; // all ⌘⇧ combos handled by menu

    const keyCodeFn: *const fn (objc.id, objc.SEL) callconv(.c) u16 =
        @ptrCast(&objc.c.objc_msgSend);
    const code = keyCodeFn(event, objc.sel("keyCode"));

    // Font size changes use pending_font_delta (deferred to pollTick)
    // so they can't go through the menu system.
    switch (code) {
        24 => pending_font_delta = 1.0,    // ⌘=
        27 => pending_font_delta = -1.0,   // ⌘-
        29 => pending_font_reset = true,    // ⌘0
        else => return objc.NO, // let menu system handle everything else
    }
    return objc.YES;
}

fn termKeyDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    // Any keypress means the user is typing, not dictating
    speech_indicator.cancel();

    const entry = findEntry(self) orelse {
        return;
    };

    // Clear selection and snap to bottom on any keypress
    entry.selection.active = false;
    entry.scroll_offset = 0;

    const modifierFlags: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSUInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const flags = modifierFlags(event, objc.sel("modifierFlags"));
    const has_cmd = (flags & (1 << 20)) != 0;
    const has_opt = (flags & (1 << 19)) != 0;
    const has_ctrl = (flags & (1 << 18)) != 0;
    const has_shift = (flags & (1 << 17)) != 0;

    if (has_cmd) {
        // All ⌘ shortcuts are handled by menu key equivalents (window.zig)
        // and performKeyEquivalent: (font size). Nothing to do here.
        return;
    }

    var mod: vt_mod.c.VTermModifier = 0;
    if (has_ctrl) mod |= vt_mod.c.VTERM_MOD_CTRL;
    if (has_shift) mod |= vt_mod.c.VTERM_MOD_SHIFT;

    // Check for special keys
    const keyCode: *const fn (objc.id, objc.SEL) callconv(.c) u16 =
        @ptrCast(&objc.c.objc_msgSend);
    const code = term_keys.KeyCode.from(keyCode(event, objc.sel("keyCode")));

    // Try special key escape sequence first
    if (term_keys.getEscapeSequence(code, has_shift)) |seq| {
        // Alt+special key: send ESC prefix then the sequence
        if (has_opt) entry.pty.write("\x1b");
        entry.pty.write(seq);
    } else {
        // Regular character input
        // Use "charactersIgnoringModifiers" for Alt combos so we get the
        // base key (e.g., 'a') rather than the macOS special character (e.g., 'å')
        const chars = if (has_opt)
            objc.msgSend(event, objc.sel("charactersIgnoringModifiers"))
        else
            objc.msgSend(event, objc.sel("characters"));
        const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(chars, objc.sel("UTF8String")));
        const str = std.mem.span(utf8);

        if (has_ctrl and str.len == 1) {
            if (term_keys.ctrlModify(str[0])) |ctrl_char| {
                entry.pty.write(&[1]u8{ctrl_char});
            } else {
                entry.pty.write(str);
            }
        } else if (has_opt and str.len > 0) {
            // Alt+key: send ESC followed by the key (standard terminal behavior)
            entry.pty.write("\x1b");
            entry.pty.write(str);
        } else if (str.len > 0) {
            entry.pty.write(str);
        }
    }

    // Trigger redraw
    objc.msgSendVoid1(self, objc.sel("setNeedsDisplay:"), objc.YES);
}

// ---------------------------------------------------------------------------
// PTY polling
// ---------------------------------------------------------------------------

fn ensurePollTimer() void {
    if (poll_timer != null) return;

    const helper_cls = registerTimerHelperClass() orelse return;
    const helper = objc.msgSend(helper_cls, objc.sel("new"));

    const NSTimer = objc.getClass("NSTimer") orelse return;
    const timerFn: *const fn (objc.id, objc.SEL, f64, ?*anyopaque, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    poll_timer = timerFn(NSTimer,
        objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        0.016, helper, objc.sel("tick:"), null, objc.YES);
}

var timer_helper_class: ?objc.id = null;

fn registerTimerHelperClass() ?objc.id {
    if (timer_helper_class) |cls| return cls;
    const NSObject = objc.getClass("NSObject") orelse return null;
    const cls = objc.allocateClassPair(NSObject, "TermPollHelper") orelse return null;
    _ = objc.addMethod(cls, objc.sel("tick:"), &pollTick, "v@:@");
    objc.registerClassPair(cls);
    timer_helper_class = cls;
    return cls;
}

var last_panel_width: f64 = 0;
var git_refresh_counter: u32 = 0;
var last_applied_font_size: f64 = 13.0;
var last_panel_height: f64 = 0;
var last_bell_state: [MAX_TERMS]bool = [_]bool{false} ** MAX_TERMS;
var last_exit_state: [MAX_TERMS]bool = [_]bool{false} ** MAX_TERMS;

fn checkForExitedTerminals() void {
    const window_ui = @import("window.zig");
    for (&sessions, 0..) |*sess, si| {
        if (sess.*) |*session| {
            // Collect all leaf slots
            var leaves: std.ArrayListUnmanaged(usize) = .{};
            defer leaves.deinit(allocator);
            session.root.collectLeaves(allocator, &leaves);

            for (leaves.items) |slot| {
                if (slot < MAX_TERMS) {
                    if (terminals[slot]) |*entry| {
                        if (entry.pty.hasExited()) {
                            // Single pane — leave it alone, user can close manually
                            if (leaves.items.len <= 1) continue;

                            // Multi-pane — auto-close this pane without confirmation
                            const leaf_node = session.root.findLeaf(slot) orelse continue;
                            const parent_node = session.root.findParent(leaf_node) orelse continue;

                            destroyTerminalAtSlot(slot);

                            const sibling = if (parent_node.split.first == leaf_node) parent_node.split.second else parent_node.split.first;
                            const sibling_copy = sibling.*;
                            allocator.destroy(leaf_node);
                            allocator.destroy(sibling);
                            parent_node.* = sibling_copy;

                            // Focus first remaining leaf
                            var remaining: std.ArrayListUnmanaged(usize) = .{};
                            defer remaining.deinit(allocator);
                            parent_node.collectLeaves(allocator, &remaining);
                            if (remaining.items.len > 0) {
                                session.focused_slot = remaining.items[0];
                            }

                            // Re-layout
                            if (active_session != null and active_session.? == si) {
                                if (window_ui.main_panel_view) |panel| {
                                    layoutActiveSession(panel);
                                    if (getFocusedView()) |focused| {
                                        const NSApp_class = objc.getClass("NSApplication") orelse return;
                                        const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
                                        const mw = objc.msgSend(nsapp, objc.sel("mainWindow"));
                                        objc.msgSendVoid1(mw, objc.sel("makeFirstResponder:"), focused);
                                    }
                                }
                            }
                            saveSplitState();
                            return; // only handle one exit per tick to avoid iterator invalidation
                        }
                    }
                }
            }
        }
    }
}

var idle_ticks: u32 = 0;

fn pollTick(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    handlePendingFontChanges();
    handlePanelResize();
    const any_data = readAllTerminals();
    updateTimerSpeed(any_data);
    checkForExitedTerminals();
    periodicRefresh();
    checkStateChanges();
}

fn handlePendingFontChanges() void {
    if (pending_font_reset) {
        pending_font_reset = false;
        pending_font_delta = 0;
        resetFontSize();
    } else if (pending_font_delta != 0) {
        const delta = pending_font_delta;
        pending_font_delta = 0;
        adjustFontSize(delta);
    }
}

fn handlePanelResize() void {
    if (active_session != null) {
        const panel = @import("window.zig").main_panel_view;
        if (panel) |p| {
            const bounds = objc.msgSendRect(p, objc.sel("bounds"));
            if (bounds.size.width != last_panel_width or bounds.size.height != last_panel_height) {
                last_panel_width = bounds.size.width;
                last_panel_height = bounds.size.height;
                layoutActiveSession(p);
            }
        }
    }
}

fn readAllTerminals() bool {
    var buf: [16384]u8 = undefined;
    var any_data = false;

    const Leftover = struct { data: [4]u8 = undefined, len: u8 = 0 };
    const leftovers = struct {
        var slots: [MAX_TERMS]Leftover = [_]Leftover{.{}} ** MAX_TERMS;
    };

    for (&terminals) |*t| {
        if (t.*) |*entry| {
            syncTermSize(entry);

            var got_data = false;
            while (true) {
                var lo = &leftovers.slots[entry.slot];
                if (lo.len > 0) {
                    @memcpy(buf[0..lo.len], lo.data[0..lo.len]);
                }
                const raw_n = entry.pty.read(buf[lo.len..]);
                if (raw_n == 0 and lo.len == 0) break;
                const n = raw_n + lo.len;
                lo.len = 0;

                const feed_len = findUtf8Boundary(&buf, n, lo);
                if (feed_len == 0) break;

                checkBell(buf[0..feed_len], entry.slot);
                entry.vterm.feed(buf[0..feed_len]);
                got_data = true;
            }
            if (got_data) {
                const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setBool(entry.view, objc.sel("setNeedsDisplay:"), objc.YES);
                any_data = true;
            }
        }
    }
    return any_data;
}

/// Find the last clean UTF-8 boundary in the buffer.
/// Saves any trailing incomplete sequence in `lo` for the next read.
fn findUtf8Boundary(buf: []u8, n: usize, lo: anytype) usize {
    var feed_len = n;
    if (n > 0) {
        var trail: usize = 0;
        var i = n;
        while (i > 0 and trail < 4) {
            i -= 1;
            const b = buf[i];
            if (b < 0x80) break;
            if (b >= 0xC0) {
                const expected: usize = if (b < 0xE0) 2 else if (b < 0xF0) 3 else 4;
                const available = n - i;
                if (available < expected) {
                    const save: u8 = @intCast(available);
                    @memcpy(lo.data[0..save], buf[i..n]);
                    lo.len = save;
                    feed_len = i;
                }
                break;
            }
            trail += 1;
        }
    }
    return feed_len;
}

/// Check for bell character (0x07) and set notification on the owning session.
fn checkBell(data: []const u8, slot: usize) void {
    for (data) |byte| {
        if (byte == 0x07) {
            for (&sessions, 0..) |*sess, si| {
                if (sess.*) |*s| {
                    var leaves: std.ArrayListUnmanaged(usize) = .{};
                    defer leaves.deinit(allocator);
                    s.root.collectLeaves(allocator, &leaves);
                    for (leaves.items) |leaf_slot| {
                        if (leaf_slot == slot) {
                            if (active_session == null or active_session.? != si) {
                                bell_active[si] = true;
                            }
                            break;
                        }
                    }
                }
            }
            break;
        }
    }
}

fn updateTimerSpeed(any_data: bool) void {
    if (any_data) {
        idle_ticks = 0;
        if (on_slow_timer) switchToFastTimer();
    } else {
        idle_ticks += 1;
        if (!on_slow_timer and idle_ticks > 30) switchToSlowTimer();
    }
}

fn periodicRefresh() void {
    const window_ui = @import("window.zig");
    const sidebar = @import("sidebar.zig");
    git_refresh_counter += 1;
    const refresh_interval: u32 = if (on_slow_timer) 100 else 625;
    if (git_refresh_counter < refresh_interval) return;

    git_refresh_counter = 0;
    sidebar.updateStats();
    saveActiveCwd();

    if (active_session) |si| {
        if (sessions[si]) |*session| {
            if (sidebar.g_sidebar_app) |app| {
                if (findTerminalInStore(app, session.terminal_id)) |t| {
                    const proj_path = blk: {
                        for (app.projects()) |proj| {
                            for (proj.terminals.items) |pt| {
                                if (std.mem.eql(u8, pt.id, session.terminal_id)) {
                                    break :blk proj.path;
                                }
                            }
                        }
                        break :blk session.cwd;
                    };
                    const git_path = blk2: {
                        if (terminals[session.focused_slot]) |*entry| {
                            var cwd_buf: [4096]u8 = undefined;
                            if (entry.pty.getCwd(&cwd_buf)) |live_cwd| {
                                break :blk2 live_cwd;
                            }
                        }
                        break :blk2 proj_path;
                    };
                    window_ui.updateHeader(t.name, git_path);
                }
            }
        }
    }
}

fn checkStateChanges() void {
    const sidebar = @import("sidebar.zig");
    var state_changed = false;
    for (0..MAX_TERMS) |i| {
        if (bell_active[i] != last_bell_state[i]) {
            state_changed = true;
            last_bell_state[i] = bell_active[i];
        }
        const exited = if (terminals[i]) |*e| e.pty.hasExited() else false;
        if (exited != last_exit_state[i]) {
            state_changed = true;
            last_exit_state[i] = exited;
        }
    }
    if (state_changed) {
        if (sidebar.g_sidebar_app) |app| {
            sidebar.rebuildSidebar(app);
        }
    }
}

var on_slow_timer: bool = false;

fn switchToSlowTimer() void {
    if (poll_timer) |t| {
        objc.msgSendVoid(t, objc.sel("invalidate"));
        poll_timer = null;
    }
    on_slow_timer = true;
    const helper_cls = registerTimerHelperClass() orelse return;
    const helper = objc.msgSend(helper_cls, objc.sel("new"));
    const NSTimer = objc.getClass("NSTimer") orelse return;
    const timerFn: *const fn (objc.id, objc.SEL, f64, ?*anyopaque, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    poll_timer = timerFn(NSTimer,
        objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        0.1, helper, objc.sel("tick:"), null, objc.YES);
}

fn switchToFastTimer() void {
    if (poll_timer) |t| {
        objc.msgSendVoid(t, objc.sel("invalidate"));
        poll_timer = null;
    }
    on_slow_timer = false;
    const helper_cls = registerTimerHelperClass() orelse return;
    const helper = objc.msgSend(helper_cls, objc.sel("new"));
    const NSTimer = objc.getClass("NSTimer") orelse return;
    const timerFn: *const fn (objc.id, objc.SEL, f64, ?*anyopaque, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    poll_timer = timerFn(NSTimer,
        objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        0.016, helper, objc.sel("tick:"), null, objc.YES);
}
