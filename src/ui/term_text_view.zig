/// Terminal view — renders a VT100 terminal grid backed by libvterm.
///
/// Uses a custom NSView that draws the character grid via Core Graphics,
/// and a PTY for the shell process.
const std = @import("std");
const objc = @import("../objc.zig");
const Pty = @import("../pty.zig").Pty;
const VTerm = @import("../vt.zig").VTerm;
const vt_mod = @import("../vt.zig");

const MAX_TERMS = 32;
const MAX_SCROLLBACK = 10000;

var terminals: [MAX_TERMS]?TermEntry = [_]?TermEntry{null} ** MAX_TERMS;
var poll_timer: ?objc.id = null;
var term_view_class: ?objc.id = null;

var font_size: f64 = 13.0;
var cell_width: f64 = 7.8;
var cell_height: f64 = 16.0;

fn updateCellMetrics() void {
    // Measure actual rendered width by creating a CTLine with 10 characters
    // and dividing by 10 — this gives the exact advance Core Text uses.
    const CT = struct {
        extern "CoreText" fn CTLineCreateWithAttributedString(attrString: *anyopaque) *anyopaque;
        extern "CoreText" fn CTLineGetTypographicBounds(line: *anyopaque, ascent: ?*f64, descent: ?*f64, leading: ?*f64) f64;
        extern "CoreFoundation" fn CFRelease(cf: *anyopaque) void;
    };

    const NSFont = objc.getClass("NSFont") orelse return;
    const monoFont: *const fn (objc.id, objc.SEL, objc.id, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const font = monoFont(NSFont, objc.sel("fontWithName:size:"), objc.nsString("Menlo"), font_size);

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
        objc.nsString("NSFont"), font, .{ .location = 0, .length = full_len });

    const ct_line = CT.CTLineCreateWithAttributedString(@ptrCast(astr));
    defer CT.CFRelease(ct_line);

    var ascent: f64 = 0;
    var descent: f64 = 0;
    var leading: f64 = 0;
    const total_width = CT.CTLineGetTypographicBounds(ct_line, &ascent, &descent, &leading);

    cell_width = total_width / 10.0;
    cell_height = @ceil(ascent + descent + leading);
}

const ScrollLine = struct {
    cells: [512]vt_mod.Cell,
    len: u16,
};

const ScrollList = std.ArrayListUnmanaged(ScrollLine);
const allocator = std.heap.page_allocator;

const Selection = struct {
    active: bool = false,
    start_col: u16 = 0,
    start_row: i32 = 0, // can be negative for scrollback
    end_col: u16 = 0,
    end_row: i32 = 0,

    fn ordered(self: Selection) struct { r1: i32, c1: u16, r2: i32, c2: u16 } {
        if (self.start_row < self.end_row or
            (self.start_row == self.end_row and self.start_col <= self.end_col))
        {
            return .{ .r1 = self.start_row, .c1 = self.start_col, .r2 = self.end_row, .c2 = self.end_col };
        }
        return .{ .r1 = self.end_row, .c1 = self.end_col, .r2 = self.start_row, .c2 = self.start_col };
    }

    fn contains(self: Selection, row: i32, col: u16) bool {
        if (!self.active) return false;
        const s = self.ordered();
        if (row < s.r1 or row > s.r2) return false;
        if (row == s.r1 and row == s.r2) return col >= s.c1 and col <= s.c2;
        if (row == s.r1) return col >= s.c1;
        if (row == s.r2) return col <= s.c2;
        return true;
    }
};

const TermEntry = struct {
    pty: Pty,
    vterm: VTerm,
    view: objc.id,
    slot: usize,
    needs_redraw: bool = true,
    scroll_offset: i32 = 0,
    scrollback: ScrollList = .{},
    selection: Selection = .{},
};

// ---------------------------------------------------------------------------
// Split tree
// ---------------------------------------------------------------------------

pub const SplitDirection = enum { horizontal, vertical };

const SplitNode = union(enum) {
    leaf: usize, // slot index into terminals[]
    split: struct {
        direction: SplitDirection,
        first: *SplitNode,
        second: *SplitNode,
        ratio: f64, // 0.0 - 1.0, portion for first child
    },

    fn destroyTree(self: *SplitNode) void {
        switch (self.*) {
            .split => |s| {
                s.first.destroyTree();
                s.second.destroyTree();
                allocator.destroy(s.first);
                allocator.destroy(s.second);
            },
            .leaf => {},
        }
    }

    fn collectLeaves(self: *SplitNode, out: *std.ArrayListUnmanaged(usize)) void {
        switch (self.*) {
            .leaf => |slot| {
                out.append(allocator, slot) catch {};
            },
            .split => |s| {
                s.first.collectLeaves(out);
                s.second.collectLeaves(out);
            },
        }
    }

    fn findLeaf(self: *SplitNode, slot: usize) ?*SplitNode {
        switch (self.*) {
            .leaf => |s| {
                if (s == slot) return self;
                return null;
            },
            .split => |s| {
                return s.first.findLeaf(slot) orelse s.second.findLeaf(slot);
            },
        }
    }

    fn findParent(self: *SplitNode, child: *SplitNode) ?*SplitNode {
        switch (self.*) {
            .leaf => return null,
            .split => |s| {
                if (s.first == child or s.second == child) return self;
                return s.first.findParent(child) orelse s.second.findParent(child);
            },
        }
    }
};

/// A session corresponds to one sidebar terminal entry and holds a split tree.
const Session = struct {
    root: *SplitNode,
    focused_slot: usize, // which terminal slot is focused
    cwd: []const u8,
    command: ?[]const u8,
};

var sessions: [MAX_TERMS]?Session = [_]?Session{null} ** MAX_TERMS;
var active_session: ?usize = null; // which session is displayed

// Bell notification tracking — indexed by sidebar entry (session index)
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

/// Get or create a session for a sidebar entry, and return a dummy view (layout handles the rest).
pub fn getOrCreateSession(index: usize, cwd: []const u8, command: ?[]const u8) bool {
    active_session = index;

    // Clear bell when switching to this session
    if (index < MAX_TERMS) bell_active[index] = false;

    if (index < MAX_TERMS and sessions[index] != null) {
        return true; // session already exists
    }

    // Create a new terminal and session
    const slot = findFreeSlot() orelse return false;
    _ = createTerminalViewAtSlot(slot, cwd, command) orelse return false;

    const root = allocator.create(SplitNode) catch return false;
    root.* = .{ .leaf = slot };

    if (index < MAX_TERMS) {
        sessions[index] = .{
            .root = root,
            .focused_slot = slot,
            .cwd = cwd,
            .command = command,
        };
    }
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
        // Git label position is set in updateHeader after text is set
        _ = window_ui.header_git_label;
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
    session.root.collectLeaves(&leaves);
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
                        setBorderWidth(layer, objc.sel("setBorderWidth:"), 0.0);
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

/// Split the focused pane in the active session.
pub fn splitFocused(direction: SplitDirection) void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    // Find the focused leaf node
    const leaf_node = session.root.findLeaf(session.focused_slot) orelse return;

    // Create a new terminal in the same cwd
    const new_slot = findFreeSlot() orelse return;
    _ = createTerminalViewAtSlot(new_slot, session.cwd, null) orelse return;

    // Replace the leaf with a split
    const old_slot = leaf_node.leaf;
    const first = allocator.create(SplitNode) catch return;
    const second = allocator.create(SplitNode) catch return;
    first.* = .{ .leaf = old_slot };
    second.* = .{ .leaf = new_slot };

    leaf_node.* = .{ .split = .{
        .direction = direction,
        .first = first,
        .second = second,
        .ratio = 0.5,
    } };

    session.focused_slot = new_slot;
}

/// Close the focused pane in the active session, with confirmation.
pub fn closeFocusedPane() void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    // Can't close if it's the only pane
    const leaf_node = session.root.findLeaf(session.focused_slot) orelse return;
    const parent_node = session.root.findParent(leaf_node) orelse return;

    // Show confirmation dialog
    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));
    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Close Pane"));
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"), objc.nsString("Close this terminal pane?"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Close"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

    // First button ("Close") is already the default — Enter confirms it
    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result != NSAlertFirstButtonReturn) return;

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
    parent_node.collectLeaves(&leaves);
    if (leaves.items.len > 0) {
        session.focused_slot = leaves.items[0];
    }
}

/// Cycle focus to the next/previous pane.
pub fn cycleFocus(forward: bool) void {
    const session_idx = active_session orelse return;
    if (session_idx >= MAX_TERMS) return;
    const session = &(sessions[session_idx] orelse return);

    var leaves: std.ArrayListUnmanaged(usize) = .{};
    defer leaves.deinit(allocator);
    session.root.collectLeaves(&leaves);

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
    dragging_divider = null;
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
    }
    const cls = term_view_class orelse return null;
    const view = objc.msgSend(cls, objc.sel("new"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(view, objc.sel("setWantsLayer:"), objc.YES);

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

    // Set up scrollback callbacks
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

    ensurePollTimer();
    return view;
}

/// Destroy a specific terminal by slot index.
pub fn destroyTerminalAtSlot(slot: usize) void {
    if (slot >= MAX_TERMS) return;
    if (terminals[slot]) |*entry| {
        entry.pty.close();
        entry.vterm.deinit();
        entry.scrollback.deinit(allocator);
        terminals[slot] = null;
    }
}

/// Destroy all terminals.
pub fn destroyAllTerminals() void {
    for (&terminals) |*t| {
        if (t.*) |*entry| {
            entry.pty.close();
            entry.vterm.deinit();
            entry.scrollback.deinit(allocator);
            t.* = null;
        }
    }
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
    _ = objc.addMethod(cls, objc.sel("acceptsFirstResponder"), &acceptsFirst, "B@:");
    _ = objc.addMethod(cls, objc.sel("becomeFirstResponder"), &becomesFirst, "B@:");
    _ = objc.addMethod(cls, objc.sel("isFlipped"), &isFlipped, "B@:");
    objc.registerClassPair(cls);
    return cls;
}

// ---------------------------------------------------------------------------
// Scrollback callbacks
// ---------------------------------------------------------------------------

fn sbPushLine(cols: c_int, cells_raw: ?*const anyopaque, user: ?*anyopaque) callconv(.c) c_int {
    const entry: *TermEntry = @ptrCast(@alignCast(user orelse return 0));
    const num_cols: u16 = @intCast(@min(@as(u16, @intCast(cols)), 512));

    var line = ScrollLine{ .cells = undefined, .len = num_cols };
    @memset(std.mem.asBytes(&line.cells), 0);

    if (cells_raw) |ptr| {
        // Each VTermScreenCell is 40 bytes
        const raw_bytes: [*]const u8 = @ptrCast(ptr);
        var i: u16 = 0;
        while (i < num_cols) : (i += 1) {
            const offset = @as(usize, i) * 40;
            var raw: vt_mod.RawScreenCell = undefined;
            @memcpy(std.mem.asBytes(&raw), raw_bytes[offset..][0..40]);

            line.cells[i] = .{
                .chars = raw.chars,
                .width = if (raw.width > 0) @intCast(raw.width) else 1,
                .fg = vt_mod.decodeVTermColor(raw.fg, vt_mod.DEFAULT_FG),
                .bg = vt_mod.decodeVTermColor(raw.bg, vt_mod.DEFAULT_BG),
            };
        }
    }

    entry.scrollback.append(allocator, line) catch {};

    if (entry.scrollback.items.len > MAX_SCROLLBACK) {
        _ = entry.scrollback.orderedRemove(0);
    }

    return 1;
}

fn sbPopLine(_: c_int, _: ?*anyopaque, user: ?*anyopaque) callconv(.c) c_int {
    const entry: *TermEntry = @ptrCast(@alignCast(user orelse return 0));
    if (entry.scrollback.items.len == 0) return 0;
    _ = entry.scrollback.pop();
    return 1;
}

fn acceptsFirst(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }
fn becomesFirst(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }
fn isFlipped(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL { return objc.YES; }

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

    const sb_len: i32 = @intCast(entry.scrollback.items.len);
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
            // and break mouse drag tracking. Just update the focus border.
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
    dragging_divider = null;

    // Copy selection to clipboard
    if (findEntry(self)) |entry| {
        if (entry.selection.active) {
            copySelectionToClipboard(entry);
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
    const sb_len: i32 = @intCast(entry.scrollback.items.len);

    var row = s.r1;
    while (row <= s.r2) : (row += 1) {
        const start_col: u16 = if (row == s.r1) s.c1 else 0;
        const end_col: u16 = if (row == s.r2) s.c2 else entry.vterm.cols - 1;

        var col = start_col;
        while (col <= end_col) : (col += 1) {
            var cell_val: vt_mod.Cell = undefined;
            if (row < 0) {
                const sb_idx = sb_len + row;
                if (sb_idx >= 0 and sb_idx < sb_len) {
                    const line = &entry.scrollback.items[@intCast(sb_idx)];
                    cell_val = if (col < line.len) line.cells[col] else .{};
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

    // Position toast at top-center of the terminal view
    const bounds = objc.msgSendRect(term_view, objc.sel("bounds"));
    const toast_w: f64 = 150;
    const toast_h: f64 = 28;
    const toast_x = (bounds.size.width - toast_w) / 2;
    setFrame(toast, objc.sel("setFrame:"), objc.NSMakeRect(toast_x, 8, toast_w, toast_h));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(toast, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(toast, objc.sel("layer"));
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.25, 0.32, 0.95);
    const cgColor = objc.msgSend(bg, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), cgColor);
    const setCornerRadius: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setCornerRadius(layer, objc.sel("setCornerRadius:"), 6.0);

    // Label
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Copied to clipboard"));
    setFrame(label, objc.sel("setFrame:"), objc.NSMakeRect(0, 4, toast_w, 20));

    const NSFont = objc.getClass("NSFont") orelse return;
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(label, objc.sel("setFont:"), sysFont(NSFont, objc.sel("systemFontOfSize:"), 12.0));

    const fg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.85, 0.9, 0.95, 1.0);
    objc.msgSendVoid1(label, objc.sel("setTextColor:"), fg);

    const setAlign: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlign(label, objc.sel("setAlignment:"), 1); // NSTextAlignmentCenter

    objc.msgSendVoid1(toast, objc.sel("addSubview:"), label);
    objc.msgSendVoid1(term_view, objc.sel("addSubview:"), toast);
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

    // Check if nil
    const NSString = objc.getClass("NSString") orelse return;
    _ = NSString;
    const lengthFn: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSUInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const len = lengthFn(ns_str, objc.sel("length"));
    if (len == 0) return;

    const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(ns_str, objc.sel("UTF8String")));
    const str = std.mem.span(utf8);
    if (str.len > 0) {
        // Use bracketed paste mode for better shell handling
        entry.pty.write("\x1b[200~");
        entry.pty.write(str);
        entry.pty.write("\x1b[201~");
    }
}

pub fn adjustFontSize(delta: f64) void {
    changeFontSize(delta);
    resizeAllTerminals();
}

fn changeFontSize(delta: f64) void {
    font_size = @max(8.0, @min(36.0, font_size + delta));
    updateCellMetrics();
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
    const usable_w = bounds.size.width - 10;
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

    const NSFont = objc.getClass("NSFont") orelse return;
    const monoFont: *const fn (objc.id, objc.SEL, objc.id, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const font = monoFont(NSFont, objc.sel("fontWithName:size:"), objc.nsString("Menlo"), font_size);

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
    const sb_len: i32 = @intCast(entry.scrollback.items.len);
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
                    const line = &entry.scrollback.items[@intCast(sb_idx)];
                    if (col < line.len) {
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
                    const line2 = &entry.scrollback.items[@intCast(sb_idx2)];
                    cell2 = if (c2 < line2.len) line2.cells[c2] else .{};
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
            if (ch > 0 and ch <= 0x10FFFF) {
                if (ch > 0xFFFF) utf16_len = 2; // surrogate pair for emoji etc.
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
        const row_nsstr = initWithBytes(
            objc.msgSend(NSString, objc.sel("alloc")),
            objc.sel("initWithBytes:length:encoding:"),
            &row_buf, row_len, 4,
        );

        const NSMutableAS = objc.getClass("NSMutableAttributedString") orelse continue;
        const astr = objc.msgSend1(
            objc.msgSend(NSMutableAS, objc.sel("alloc")),
            objc.sel("initWithString:"),
            row_nsstr,
        );

        const full_len = objc.msgSendUInt(astr, objc.sel("length"));
        const addAttr: *const fn (objc.id, objc.SEL, objc.id, objc.id, objc.NSRange) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);

        // Set monospace font on entire row
        addAttr(astr, objc.sel("addAttribute:value:range:"),
            objc.nsString("NSFont"), font, .{ .location = 0, .length = full_len });

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
                objc.nsString("NSColor"), fg_obj, .{ .location = utf16_pos, .length = run_len });
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
    }
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

fn termKeyDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    const entry = findEntry(self) orelse {
        return;
    };

    // Clear selection on any keypress
    entry.selection.active = false;

    const modifierFlags: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSUInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const flags = modifierFlags(event, objc.sel("modifierFlags"));
    const has_cmd = (flags & (1 << 20)) != 0;
    const has_ctrl = (flags & (1 << 18)) != 0;
    const has_shift = (flags & (1 << 17)) != 0;

    // Handle ⌘+ / ⌘- for font size, let other ⌘ shortcuts pass to system
    if (has_cmd) {
        const keyCodeFn: *const fn (objc.id, objc.SEL) callconv(.c) u16 =
            @ptrCast(&objc.c.objc_msgSend);
        const code = keyCodeFn(event, objc.sel("keyCode"));
        const chars = objc.msgSend(event, objc.sel("characters"));
        const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(chars, objc.sel("UTF8String")));
        const str = std.mem.span(utf8);
        if (str.len == 1) {
            // keyCode 24 = =/+ key, keyCode 27 = -/_ key, keyCode 29 = 0
            if (str[0] == '+' or str[0] == '=' or code == 24) {
                changeFontSize(1.0);
                resizeAllTerminals();
                objc.msgSendVoid1(self, objc.sel("setNeedsDisplay:"), objc.YES);
                return;
            } else if (str[0] == '-' or code == 27) {
                changeFontSize(-1.0);
                resizeAllTerminals();
                objc.msgSendVoid1(self, objc.sel("setNeedsDisplay:"), objc.YES);
                return;
            } else if (str[0] == '0' or code == 29) {
                font_size = 13.0;
                updateCellMetrics();
                resizeAllTerminals();
                objc.msgSendVoid1(self, objc.sel("setNeedsDisplay:"), objc.YES);
                return;
            } else if (str[0] == 'v' or code == 9) {
                // ⌘V — paste from clipboard into PTY
                pasteFromClipboard(entry);
                return;
            }
        }
        return;
    }

    var mod: vt_mod.c.VTermModifier = 0;
    if (has_ctrl) mod |= vt_mod.c.VTERM_MOD_CTRL;
    if (has_shift) mod |= vt_mod.c.VTERM_MOD_SHIFT;

    // Check for special keys
    const keyCode: *const fn (objc.id, objc.SEL) callconv(.c) u16 =
        @ptrCast(&objc.c.objc_msgSend);
    const code = keyCode(event, objc.sel("keyCode"));

    const vterm_key: ?vt_mod.c.VTermKey = switch (code) {
        36 => vt_mod.c.VTERM_KEY_ENTER,
        48 => vt_mod.c.VTERM_KEY_TAB,
        51 => vt_mod.c.VTERM_KEY_BACKSPACE,
        53 => vt_mod.c.VTERM_KEY_ESCAPE,
        126 => vt_mod.c.VTERM_KEY_UP,
        125 => vt_mod.c.VTERM_KEY_DOWN,
        124 => vt_mod.c.VTERM_KEY_RIGHT,
        123 => vt_mod.c.VTERM_KEY_LEFT,
        117 => vt_mod.c.VTERM_KEY_DEL,
        115 => vt_mod.c.VTERM_KEY_HOME,
        119 => vt_mod.c.VTERM_KEY_END,
        116 => vt_mod.c.VTERM_KEY_PAGEUP,
        121 => vt_mod.c.VTERM_KEY_PAGEDOWN,
        else => null,
    };

    // Write directly to PTY — vterm is used only for parsing output, not generating input
    if (vterm_key) |key| {
        const seq: ?[]const u8 = switch (key) {
            vt_mod.c.VTERM_KEY_ENTER => "\r",
            vt_mod.c.VTERM_KEY_TAB => "\t",
            vt_mod.c.VTERM_KEY_BACKSPACE => "\x7f",
            vt_mod.c.VTERM_KEY_ESCAPE => "\x1b",
            vt_mod.c.VTERM_KEY_UP => "\x1b[A",
            vt_mod.c.VTERM_KEY_DOWN => "\x1b[B",
            vt_mod.c.VTERM_KEY_RIGHT => "\x1b[C",
            vt_mod.c.VTERM_KEY_LEFT => "\x1b[D",
            vt_mod.c.VTERM_KEY_HOME => "\x1b[H",
            vt_mod.c.VTERM_KEY_END => "\x1b[F",
            vt_mod.c.VTERM_KEY_PAGEUP => "\x1b[5~",
            vt_mod.c.VTERM_KEY_PAGEDOWN => "\x1b[6~",
            vt_mod.c.VTERM_KEY_DEL => "\x1b[3~",
            else => null,
        };
        if (seq) |s| entry.pty.write(s);
    } else {
        // Regular character input
        const chars = objc.msgSend(event, objc.sel("characters"));
        const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(chars, objc.sel("UTF8String")));
        const str = std.mem.span(utf8);

        if (has_ctrl and str.len == 1) {
            const ch = str[0];
            if (ch >= 'a' and ch <= 'z') {
                entry.pty.write(&[1]u8{ch - 'a' + 1});
            } else if (ch >= 'A' and ch <= 'Z') {
                entry.pty.write(&[1]u8{ch - 'A' + 1});
            } else {
                entry.pty.write(str);
            }
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
var last_panel_height: f64 = 0;
var last_bell_state: [MAX_TERMS]bool = [_]bool{false} ** MAX_TERMS;

fn pollTick(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    // Re-layout if the panel size changed (window resize)
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

    var buf: [16384]u8 = undefined;

    for (&terminals) |*t| {
        if (t.*) |*entry| {
            // Sync terminal size to view bounds
            syncTermSize(entry);

            var got_data = false;
            while (true) {
                const n = entry.pty.read(&buf);
                if (n == 0) break;

                // Check for bell character (0x07) — set notification on the session
                for (buf[0..n]) |byte| {
                    if (byte == 0x07) {
                        // Find which session owns this terminal
                        for (&sessions, 0..) |*sess, si| {
                            if (sess.*) |*s| {
                                var leaves: std.ArrayListUnmanaged(usize) = .{};
                                defer leaves.deinit(allocator);
                                s.root.collectLeaves(&leaves);
                                for (leaves.items) |slot| {
                                    if (slot == entry.slot) {
                                        // Only set bell if this isn't the active session
                                        if (active_session == null or active_session.? != si) {
                                            bell_active[si] = true;
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                        break; // one bell per read is enough
                    }
                }

                entry.vterm.feed(buf[0..n]);
                got_data = true;
            }
            if (got_data) {
                // Trigger redraw
                const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setBool(entry.view, objc.sel("setNeedsDisplay:"), objc.YES);
            }
        }
    }

    // Check if bell state changed and rebuild sidebar
    var bell_changed = false;
    for (0..MAX_TERMS) |i| {
        if (bell_active[i] != last_bell_state[i]) {
            bell_changed = true;
            last_bell_state[i] = bell_active[i];
        }
    }
    if (bell_changed) {
        const sidebar = @import("../ui/sidebar.zig");
        if (sidebar.g_sidebar_app) |app| {
            sidebar.rebuildSidebar(app);
        }
    }
}
