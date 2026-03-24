/// Sidebar — project list with expandable sub-items.
///
/// Renders a simple list of projects with clickable rows.
/// Each project shows its name and sub-items (Git, terminals).
const std = @import("std");
const objc = @import("../objc.zig");
const app_mod = @import("../app.zig");
const project_mod = @import("../project.zig");
const window_ui = @import("window.zig");
const term_text_view = @import("term_text_view.zig");

/// Global reference so callbacks can reach the app.
pub var g_sidebar_app: ?*app_mod.App = null;

/// The NSView that holds the project list (inside the scroll view).
var project_list_view: ?objc.id = null;

/// The sidebar root view (so we can access it for rebuilds).
var sidebar_root_view: ?objc.id = null;

/// Stats bar label at the bottom of the sidebar.
var stats_label: ?objc.id = null;

/// Track which project the "Add Terminal" button targets (by index).
var add_terminal_project_id: ?[]const u8 = null;

/// Registered button handler class.
var add_terminal_btn_class: ?objc.id = null;

/// Currently selected terminal index (for highlighting).
var selected_terminal_index: ?usize = null;

/// Navigation items — includes terminals and "Add Terminal" buttons.
const NavItemKind = enum { terminal, add_terminal };
const NavItem = struct {
    kind: NavItemKind,
    index: usize, // term_row_info index for terminals, project index for add_terminal
};
var nav_items: [128]?NavItem = [_]?NavItem{null} ** 128;
var nav_item_count: usize = 0;
var selected_nav_index: ?usize = null;

// ---------------------------------------------------------------------------
// Drag-and-drop state
// ---------------------------------------------------------------------------
const DragItemKind = enum { terminal, project };
const DragState = struct {
    active: bool = false,
    kind: DragItemKind = .terminal,
    // For terminals: project_id + terminal_id + source project index
    project_id: []const u8 = "",
    terminal_id: []const u8 = "",
    project_idx: usize = 0,
    terminal_idx: usize = 0, // index within project's terminals
    start_y: objc.CGFloat = 0,
    current_y: objc.CGFloat = 0,
    drop_target_y: objc.CGFloat = 0, // y position of drop indicator
    drop_project_idx: usize = 0,
    drop_terminal_idx: usize = 0, // insert before this index
};
var drag_state: DragState = .{};
const PROJECT_IDX_OFFSET: usize = 10000; // offset to distinguish project vs terminal indices
var drag_indicator_view: ?objc.id = null;
var drag_source_view: ?objc.id = null; // the row being dragged (to fade it)
var drag_row_class: ?objc.id = null;

/// Create the sidebar view hierarchy.
pub fn createSidebarView() objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const sidebar_view = objc.msgSend(NSView, objc.sel("new"));
    sidebar_root_view = sidebar_view;

    // Background color
    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(sidebar_view, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(sidebar_view, objc.sel("layer"));
    setBackgroundColor(layer, 0.09, 0.114, 0.149); // #171d26

    // --- Header: "PROJECTS" + "+" button ---
    const header = createSidebarHeader();
    objc.msgSendVoid1(sidebar_view, objc.sel("addSubview:"), header);

    // --- Scroll view with project list ---
    const scroll = createProjectListScrollView();
    objc.msgSendVoid1(sidebar_view, objc.sel("addSubview:"), scroll);

    // --- Stats bar at bottom ---
    const stats_bar = createStatsBar();
    objc.msgSendVoid1(sidebar_view, objc.sel("addSubview:"), stats_bar);

    // Layout: header at top (44px), stats bar at bottom (24px), scroll fills middle
    pinToEdges(header, sidebar_view, .{ .bottom = false });
    setHeight(header, 44.0);

    pinToEdges(stats_bar, sidebar_view, .{ .top = false });
    setHeight(stats_bar, 34.0);

    pinToEdges(scroll, sidebar_view, .{ .top = false, .bottom = false });
    pinTopToBottom(scroll, header);
    pinBottomToTop(scroll, stats_bar);

    return sidebar_view;
}

/// Rebuild the sidebar content from current app state.
/// Create an ObjC object with `new` and immediately `autorelease` it.
/// The caller must ensure an autorelease pool is active.
fn newAutorelease(cls: objc.id) objc.id {
    const obj = objc.msgSend(cls, objc.sel("new"));
    return objc.msgSend(obj, objc.sel("autorelease"));
}

pub fn rebuildSidebar(application: *app_mod.App) void {
    // Wrap in autorelease pool — all views created during rebuild are autoreleased.
    // They survive because addSubview: retains them. When removeAllSubviews is called
    // on the next rebuild, removeFromSuperview drops the sole remaining retain → dealloc.
    const NSAutoreleasePool = objc.getClass("NSAutoreleasePool") orelse return;
    const pool = objc.msgSend(NSAutoreleasePool, objc.sel("new"));
    defer objc.msgSendVoid(pool, objc.sel("drain"));

    g_sidebar_app = application;
    const list_view = project_list_view orelse return;

    // Remove all existing subviews
    removeAllSubviews(list_view);

    // Reset terminal row info and nav item tracking
    term_row_info_count = 0;
    nav_item_count = 0;

    // Add a row for each project
    var y_offset: objc.CGFloat = 0;
    const row_height: objc.CGFloat = 36.0;
    const sub_row_height: objc.CGFloat = 28.0;

    // Determine which project contains the selected terminal or add-terminal
    var active_project_id: ?[]const u8 = null;
    if (selected_terminal_index) |sel_idx| {
        var count: usize = 0;
        for (application.projects()) |proj| {
            for (proj.terminals.items) |_| {
                if (count == sel_idx) {
                    active_project_id = proj.id;
                    break;
                }
                count += 1;
            }
            if (active_project_id != null) break;
        }
    }
    // Also check if an "Add Terminal" nav item is selected
    if (active_project_id == null) {
        if (selected_nav_index) |nav_idx| {
            if (nav_idx < nav_item_count) {
                // Nav items aren't built yet, but we can check the previous state
                // Actually, check isAddTerminalSelected per project below
            }
        }
        // Check which project's add-terminal is selected via isAddTerminalSelected
        for (application.projects()) |proj| {
            if (isAddTerminalSelected(proj.id)) {
                active_project_id = proj.id;
                break;
            }
        }
    }

    for (application.projects(), 0..) |proj, proj_i| {
        const is_active_project = if (active_project_id) |aid| std.mem.eql(u8, proj.id, aid) else false;

        // Project header row
        const row = createProjectRow(proj.name, y_offset, row_height, true, proj_i, is_active_project);
        // Highlight active project header
        if (is_active_project) {
            const setBoolP: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setBoolP(row, objc.sel("setWantsLayer:"), objc.YES);
            const layer = objc.msgSend(row, objc.sel("layer"));
            setLayerBgColor(layer, 0.15, 0.19, 0.24); // #263040 — subtle highlight
        }
        objc.msgSendVoid1(list_view, objc.sel("addSubview:"), row);
        y_offset += row_height;

        // Terminal sub-items (clickable)
        for (proj.terminals.items, 0..) |term, ti| {
            const term_info_idx = term_row_info_count;
            const term_row = createTerminalRow(term.name, proj.path, term.command, proj.id, term.id, y_offset, sub_row_height, ti, is_active_project);
            objc.msgSendVoid1(list_view, objc.sel("addSubview:"), term_row);
            y_offset += sub_row_height;

            // Register as nav item
            if (nav_item_count < nav_items.len) {
                nav_items[nav_item_count] = .{ .kind = .terminal, .index = term_info_idx };
                nav_item_count += 1;
            }
        }

        // "Add Terminal" button row
        const add_term_proj_idx = blk: {
            for (application.projects(), 0..) |p, pi| {
                if (std.mem.eql(u8, p.id, proj.id)) break :blk pi;
            }
            break :blk @as(usize, 0);
        };
        // Register as nav item
        if (nav_item_count < nav_items.len) {
            nav_items[nav_item_count] = .{ .kind = .add_terminal, .index = add_term_proj_idx };
            nav_item_count += 1;
        }
        const add_term_row = createAddTerminalRow(proj.id, y_offset, sub_row_height, is_active_project);
        objc.msgSendVoid1(list_view, objc.sel("addSubview:"), add_term_row);
        y_offset += sub_row_height;

        // Separator line
        const sep = createSeparatorLine(y_offset);
        objc.msgSendVoid1(list_view, objc.sel("addSubview:"), sep);
        y_offset += 1;
    }

    // Set the content size of the list view
    const setFrameSize: *const fn (objc.id, objc.SEL, objc.NSSize) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameSize(list_view, objc.sel("setFrameSize:"), .{ .width = 200.0, .height = y_offset });
}

/// Show the "Add Project" open panel.
pub fn showAddProjectPanel(application: *app_mod.App) void {
    const NSOpenPanel = objc.getClass("NSOpenPanel") orelse return;
    const panel = objc.msgSend(NSOpenPanel, objc.sel("openPanel"));

    objc.msgSendVoid1(panel, objc.sel("setTitle:"), objc.nsString("Select Project Folder"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(panel, objc.sel("setCanChooseFiles:"), objc.NO);
    setBool(panel, objc.sel("setCanChooseDirectories:"), objc.YES);
    setBool(panel, objc.sel("setCanCreateDirectories:"), objc.YES);

    // Run modal
    const result = objc.msgSendUInt(panel, objc.sel("runModal"));
    const NSModalResponseOK: objc.NSUInteger = 1;
    if (result != NSModalResponseOK) return;

    // Get selected URL
    const urls = objc.msgSend(panel, objc.sel("URLs"));
    const count = objc.msgSendUInt(urls, objc.sel("count"));
    if (count == 0) return;

    const url = objc.msgSend1(urls, objc.sel("objectAtIndex:"), @as(objc.NSUInteger, 0));
    const path_nsstring = objc.msgSend(url, objc.sel("path"));

    // Convert NSString to Zig slice
    const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(path_nsstring, objc.sel("UTF8String")));
    const path = std.mem.span(utf8);

    // Add the project
    _ = application.addProject(path) catch return;
    rebuildSidebar(application);
}

// ---------------------------------------------------------------------------
// Internal view construction
// ---------------------------------------------------------------------------

fn createSidebarHeader() objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const header = objc.msgSend(NSView, objc.sel("new"));

    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(header, objc.sel("setWantsLayer:"), objc.YES);

    // Bottom border
    const layer = objc.msgSend(header, objc.sel("layer"));
    setBorderBottom(layer);

    // "PROJECTS" label
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("PROJECTS"));

    const NSFont = objc.getClass("NSFont") orelse unreachable;
    const boldFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const font = boldFont(NSFont, objc.sel("boldSystemFontOfSize:"), 10.0);
    objc.msgSendVoid1(label, objc.sel("setFont:"), font);
    setTextColor(label, 0.604, 0.659, 0.737); // #9aa8bc

    objc.msgSendVoid1(header, objc.sel("addSubview:"), label);

    // "+" button — use a simple NSButton with bezel style
    const NSButton = objc.getClass("NSButton") orelse unreachable;
    const add_btn = objc.msgSend(NSButton, objc.sel("new"));
    objc.msgSendVoid1(add_btn, objc.sel("setTitle:"), objc.nsString("+"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(add_btn, objc.sel("setBordered:"), objc.NO);

    objc.msgSendVoid1(add_btn, objc.sel("setAction:"), objc.sel("addProject:"));
    // target nil = responder chain
    const setTarget: *const fn (objc.id, objc.SEL, ?*anyopaque) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTarget(add_btn, objc.sel("setTarget:"), null);

    objc.msgSendVoid1(header, objc.sel("addSubview:"), add_btn);

    // Layout
    centerVertically(label, header);
    pinLeading(label, header, 16.0);

    centerVertically(add_btn, header);
    pinTrailing(add_btn, header, -14.0);

    return header;
}

fn createProjectListScrollView() objc.id {
    const NSScrollView = objc.getClass("NSScrollView") orelse unreachable;
    const scroll = objc.msgSend(NSScrollView, objc.sel("new"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(scroll, objc.sel("setDrawsBackground:"), false);
    setBool(scroll, objc.sel("setHasVerticalScroller:"), true);

    setBool(scroll, objc.sel("setHasVerticalScroller:"), true);

    // Create a flipped NSView subclass so origin is top-left
    const flipped_cls = registerFlippedViewClass() orelse unreachable;
    const doc_view = objc.msgSend(flipped_cls, objc.sel("new"));

    // Store reference for rebuilds
    project_list_view = doc_view;

    objc.msgSendVoid1(scroll, objc.sel("setDocumentView:"), doc_view);

    return scroll;
}

var flipped_view_class: ?objc.id = null;

fn registerFlippedViewClass() ?objc.id {
    if (flipped_view_class) |cls| return cls;
    const NSView = objc.getClass("NSView") orelse return null;
    const cls = objc.allocateClassPair(NSView, "FlippedView") orelse return null;
    _ = objc.addMethod(cls, objc.sel("isFlipped"), &flippedYes, "B@:");
    objc.registerClassPair(cls);
    flipped_view_class = cls;
    return cls;
}

fn flippedYes(_: objc.id, _: objc.SEL) callconv(.c) objc.BOOL {
    return objc.YES;
}

fn createProjectRow(name: []const u8, y_offset: objc.CGFloat, height: objc.CGFloat, is_header: bool, project_idx: ?usize, is_active_project: bool) objc.id {
    // Use draggable view for project headers
    const row = if (is_header and project_idx != null)
        newAutorelease(registerDragRowClass() orelse objc.getClass("NSView") orelse unreachable)
    else
        newAutorelease(objc.getClass("NSView") orelse unreachable);

    // Set frame manually (within the flipped document view)
    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrame(row, objc.sel("setFrame:"), objc.NSMakeRect(0, y_offset, 200, height));

    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(row, objc.sel("setWantsLayer:"), objc.YES);

    // Label
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(name));

    const NSFont = objc.getClass("NSFont") orelse unreachable;
    if (is_header) {
        const boldFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const font = boldFont(NSFont, objc.sel("boldSystemFontOfSize:"), 13.0);
        objc.msgSendVoid1(label, objc.sel("setFont:"), font);
        if (is_active_project) {
            setTextColor(label, 0.847, 0.937, 0.906); // #d8efe7 — bright
        } else {
            setTextColor(label, 0.45, 0.50, 0.56); // dimmed
        }
    } else {
        const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const font = sysFont(NSFont, objc.sel("systemFontOfSize:"), 12.0);
        objc.msgSendVoid1(label, objc.sel("setFont:"), font);
        setTextColor(label, 0.604, 0.659, 0.737); // #9aa8bc
    }

    objc.msgSendVoid1(row, objc.sel("addSubview:"), label);

    // Position label within row
    const indent: objc.CGFloat = if (is_header) 16.0 else 32.0;
    centerVertically(label, row);
    pinLeading(label, row, indent);

    // Store project index for drag (use PROJECT_IDX_OFFSET to distinguish from terminal indices)
    if (is_header) {
        if (project_idx) |pi| {
            setRowInfoIdx(row, pi + PROJECT_IDX_OFFSET);

            // Right-click context menu for project
            const NSMenu = objc.getClass("NSMenu") orelse return row;
            const NSMenuItem = objc.getClass("NSMenuItem") orelse return row;
            const menu = newAutorelease(NSMenu);

            const initItem: *const fn (objc.id, objc.SEL, objc.id, objc.SEL, objc.id) callconv(.c) objc.id =
                @ptrCast(&objc.c.objc_msgSend);
            const setTag: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);

            const delete_item = initItem(
                newAutorelease(NSMenuItem),
                objc.sel("initWithTitle:action:keyEquivalent:"),
                objc.nsString("Delete Project"),
                objc.sel("deleteProject:"),
                objc.nsString(""),
            );
            setTag(delete_item, objc.sel("setTag:"), @intCast(pi));
            objc.msgSendVoid1(menu, objc.sel("addItem:"), delete_item);

            objc.msgSendVoid1(row, objc.sel("setMenu:"), menu);
        }
    }

    return row;
}

/// Stored info for terminal rows so the click handler knows what to open.
pub const TermRowInfo = struct {
    path: []const u8,
    command: ?[]const u8,
    project_id: []const u8,
    terminal_id: []const u8,
};
var term_row_infos: [64]?TermRowInfo = [_]?TermRowInfo{null} ** 64;

pub fn getTermRowInfo(index: usize) ?TermRowInfo {
    if (index >= term_row_infos.len) return null;
    return term_row_infos[index];
}
var term_row_info_count: usize = 0;



fn registerDragRowClass() ?objc.id {
    if (drag_row_class) |cls| return cls;
    const NSView = objc.getClass("NSView") orelse return null;
    const cls = objc.allocateClassPair(NSView, "DragRowView4") orelse {
        return null;
    };
    // Add ivar to store the info_idx
    _ = objc.addIvar(cls, "_infoIdx", @sizeOf(usize), @alignOf(usize), "Q");
    _ = objc.addMethod(cls, objc.sel("mouseDown:"), &dragRowMouseDown, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseDragged:"), &dragRowMouseDragged, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseUp:"), &dragRowMouseUp, "v@:@");
    _ = objc.addMethod(cls, objc.sel("rightMouseDown:"), &dragRowRightMouseDown, "v@:@");
    objc.registerClassPair(cls);
    drag_row_class = cls;
    return cls;
}

fn setRowInfoIdx(view: objc.id, idx: usize) void {
    const ivar = objc.c.class_getInstanceVariable(objc.c.object_getClass(@ptrCast(@alignCast(view))), "_infoIdx");
    if (ivar) |iv| {
        const offset = objc.c.ivar_getOffset(iv);
        const base: usize = @intFromPtr(view);
        const ptr: *usize = @ptrFromInt(base +% @as(usize, @bitCast(@as(isize, offset))));
        ptr.* = idx;
    }
}

fn getRowInfoIdx(view: objc.id) ?usize {
    const ivar = objc.c.class_getInstanceVariable(objc.c.object_getClass(@ptrCast(@alignCast(view))), "_infoIdx");
    if (ivar) |iv| {
        const offset = objc.c.ivar_getOffset(iv);
        const base: usize = @intFromPtr(view);
        const ptr: *usize = @ptrFromInt(base +% @as(usize, @bitCast(@as(isize, offset))));
        return ptr.*;
    }
    return null;
}

fn dragRowMouseDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    // Record start position for drag detection
    const loc = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const idx = getRowInfoIdx(self) orelse return;

    // Check if this is a project header (idx >= PROJECT_IDX_OFFSET)
    if (idx >= PROJECT_IDX_OFFSET) {
        const pi = idx - PROJECT_IDX_OFFSET;
        drag_state = .{
            .active = false,
            .kind = .project,
            .project_idx = pi,
            .start_y = loc.origin.y,
            .current_y = loc.origin.y,
        };
        drag_source_view = self;
        return;
    }

    // Terminal row
    if (idx >= term_row_infos.len) return;
    const info = term_row_infos[idx] orelse return;

    const app = g_sidebar_app orelse return;
    for (app.projects(), 0..) |proj, pi| {
        if (std.mem.eql(u8, proj.id, info.project_id)) {
            for (proj.terminals.items, 0..) |t, ti| {
                if (std.mem.eql(u8, t.id, info.terminal_id)) {
                    drag_state = .{
                        .active = false,
                        .kind = .terminal,
                        .project_id = info.project_id,
                        .terminal_id = info.terminal_id,
                        .project_idx = pi,
                        .terminal_idx = ti,
                        .start_y = loc.origin.y,
                        .current_y = loc.origin.y,
                    };
                    drag_source_view = self;
                    return;
                }
            }
        }
    }
}

fn dragRowMouseDragged(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    const loc = objc.msgSendRect(event, objc.sel("locationInWindow"));
    const dy = loc.origin.y - drag_state.start_y;

    // Only start drag after moving 5px
    if (!drag_state.active and @abs(dy) > 5) {
        drag_state.active = true;
        // Fade the source row
        if (drag_source_view) |src| {
            const setAlpha: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setAlpha(src, objc.sel("setAlphaValue:"), 0.3);
        }
        // Set resize cursor (up-down arrows)
        const NSCursor = objc.getClass("NSCursor") orelse unreachable;
        const cursor = objc.msgSend(NSCursor, objc.sel("resizeUpDownCursor"));
        objc.msgSendVoid(cursor, objc.sel("push"));
        showDragIndicator();
    }

    if (!drag_state.active) return;
    drag_state.current_y = loc.origin.y;

    // Convert to sidebar document view coordinates
    const doc_view = project_list_view orelse return;
    const convertPoint: *const fn (objc.id, objc.SEL, objc.NSPoint, ?*anyopaque) callconv(.c) objc.NSPoint =
        @ptrCast(&objc.c.objc_msgSend);
    const doc_loc = convertPoint(doc_view, objc.sel("convertPoint:fromView:"), loc.origin, null);

    // Find drop position based on y coordinate
    updateDropTarget(doc_loc.y);

    _ = self;
}

fn dragRowMouseUp(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    if (drag_state.active) {
        // Restore source row alpha
        if (drag_source_view) |src| {
            const setAlpha: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setAlpha(src, objc.sel("setAlphaValue:"), 1.0);
        }
        // Restore cursor
        const NSCursor = objc.getClass("NSCursor") orelse unreachable;
        objc.msgSendVoid(NSCursor, objc.sel("pop"));
        // Perform the reorder
        performDrop();
        hideDragIndicator();
        drag_state.active = false;

        if (g_sidebar_app) |app| rebuildSidebar(app);
    } else {
        // Was just a click, not a drag — forward to the button inside
        if (getRowInfoIdx(self)) |idx| {
            openTerminalAtIndex(idx);
        }
    }
    drag_state = .{};
    drag_source_view = null;
    _ = event;
}

fn dragRowRightMouseDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    // Show the context menu on the wrapper
    const menu = objc.msgSend(self, objc.sel("menu"));
    if (menu != objc.nil) {
        const NSMenu = objc.getClass("NSMenu") orelse return;
        const popUp: *const fn (objc.id, objc.SEL, objc.id, objc.id, objc.id) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        popUp(NSMenu, objc.sel("popUpContextMenu:withEvent:forView:"), menu, event, self);
    }
}

fn showDragIndicator() void {
    if (drag_indicator_view != null) return;
    const doc_view = project_list_view orelse return;

    const NSView = objc.getClass("NSView") orelse return;
    const indicator = objc.msgSend(NSView, objc.sel("new"));
    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrame(indicator, objc.sel("setFrame:"), objc.NSMakeRect(16, 0, 200 - 32, 2));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(indicator, objc.sel("setWantsLayer:"), objc.YES);
    const layer = objc.msgSend(indicator, objc.sel("layer"));
    setBackgroundColor(layer, 0.29, 0.565, 0.851); // blue

    objc.msgSendVoid1(doc_view, objc.sel("addSubview:"), indicator);
    drag_indicator_view = indicator;
}

fn hideDragIndicator() void {
    if (drag_indicator_view) |v| {
        objc.msgSendVoid(v, objc.sel("removeFromSuperview"));
        objc.msgSendVoid(v, objc.sel("release"));
        drag_indicator_view = null;
    }
}

fn updateDropTarget(doc_y: objc.CGFloat) void {
    const app = g_sidebar_app orelse return;
    const projs = app.projects();

    const row_h: objc.CGFloat = 36.0;
    const sub_h: objc.CGFloat = 28.0;

    if (drag_state.kind == .project) {
        // Project-level reorder: find which project slot the cursor is over
        var y: objc.CGFloat = 0;
        for (projs, 0..) |proj, pi| {
            const proj_height = row_h + sub_h * @as(objc.CGFloat, @floatFromInt(proj.terminals.items.len)) + sub_h + 1;
            if (doc_y < y + proj_height / 2) {
                drag_state.drop_project_idx = pi;
                moveDragIndicator(y);
                return;
            }
            y += proj_height;
        }
        // After last project
        drag_state.drop_project_idx = projs.len;
        moveDragIndicator(y);
        return;
    }

    // Terminal-level reorder within the same project
    var y: objc.CGFloat = 0;
    for (projs, 0..) |proj, pi| {
        if (!std.mem.eql(u8, proj.id, drag_state.project_id)) {
            y += row_h;
            y += sub_h * @as(objc.CGFloat, @floatFromInt(proj.terminals.items.len));
            y += sub_h; // add terminal button
            y += 1; // separator
            continue;
        }

        y += row_h; // project header

        // Check each terminal slot
        for (proj.terminals.items, 0..) |_, ti| {
            if (doc_y < y + sub_h / 2) {
                drag_state.drop_project_idx = pi;
                drag_state.drop_terminal_idx = ti;
                moveDragIndicator(y);
                return;
            }
            y += sub_h;
        }
        // After last terminal
        drag_state.drop_project_idx = pi;
        drag_state.drop_terminal_idx = proj.terminals.items.len;
        moveDragIndicator(y);
        return;
    }
}

fn moveDragIndicator(y: objc.CGFloat) void {
    const indicator = drag_indicator_view orelse return;
    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrame(indicator, objc.sel("setFrame:"), objc.NSMakeRect(16, y - 1, 200 - 32, 2));
}

fn performDrop() void {
    const app = g_sidebar_app orelse return;

    if (drag_state.kind == .project) {
        // Project reorder
        const src = drag_state.project_idx;
        var dst = drag_state.drop_project_idx;

        if (src == dst or (src + 1 == dst)) return; // no-op

        const item = app.store.projects.orderedRemove(src);
        if (dst > src) dst -= 1;
        app.store.projects.insert(dst, item) catch return;
        app.store.save() catch {};
        return;
    }

    // Terminal reorder within project
    const proj = app.store.findById(drag_state.project_id) orelse return;

    const src = drag_state.terminal_idx;
    var dst = drag_state.drop_terminal_idx;

    if (src == dst or (src + 1 == dst)) return; // no-op

    // Remove from source position
    const item = proj.terminals.orderedRemove(src);

    // Adjust destination if it was after the source
    if (dst > src) dst -= 1;

    // Insert at destination
    proj.terminals.insert(dst, item) catch return;

    // Save
    app.store.save() catch {};
}

fn createTerminalRow(name: []const u8, project_path: []const u8, command: ?[]const u8, project_id: []const u8, terminal_id: []const u8, y_offset: objc.CGFloat, height: objc.CGFloat, _: usize, is_active_project: bool) objc.id {
    // Active terminal (actually open in the main panel)
    const is_selected = if (selected_terminal_index) |sel| sel == term_row_info_count else false;
    // Nav-highlighted terminal (⌘⇧[] navigation, not yet activated)
    const is_nav_highlighted = blk: {
        const ni = selected_nav_index orelse break :blk false;
        if (ni >= nav_items.len) break :blk false;
        const item = nav_items[ni] orelse break :blk false;
        break :blk item.kind == .terminal and item.index == term_row_info_count;
    };

    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    // Create label (NSTextField) instead of button so wrapper gets mouse events
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const label = newAutorelease(NSTextField);
    objc.msgSendVoid1(label, objc.sel("setStringValue:"), objc.nsString(name));
    setBool(label, objc.sel("setBezeled:"), objc.NO);
    setBool(label, objc.sel("setDrawsBackground:"), objc.NO);
    setBool(label, objc.sel("setEditable:"), objc.NO);
    setBool(label, objc.sel("setSelectable:"), objc.NO);

    const setAlignment: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlignment(label, objc.sel("setAlignment:"), 0); // NSTextAlignmentLeft

    const NSFont = objc.getClass("NSFont") orelse unreachable;
    if (is_selected) {
        const boldFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const font = boldFont(NSFont, objc.sel("boldSystemFontOfSize:"), 12.0);
        objc.msgSendVoid1(label, objc.sel("setFont:"), font);
    } else {
        const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const font = sysFont(NSFont, objc.sel("systemFontOfSize:"), 12.0);
        objc.msgSendVoid1(label, objc.sel("setFont:"), font);
    }

    // Set text color
    if (is_selected) {
        setTextColor(label, 1.0, 1.0, 1.0); // white
    } else {
        setTextColor(label, 0.604, 0.659, 0.737); // #9aa8bc — same as project sub-items
    }

    // Draggable wrapper view
    const drag_cls = registerDragRowClass() orelse objc.getClass("NSView") orelse unreachable;
    const wrapper = newAutorelease(drag_cls);
    setFrame(wrapper, objc.sel("setFrame:"), objc.NSMakeRect(0, y_offset, 200, height));

    setBool(wrapper, objc.sel("setWantsLayer:"), objc.YES);
    const wrapper_layer = objc.msgSend(wrapper, objc.sel("layer"));
    if (is_selected) {
        setLayerBgColor(wrapper_layer, 0.25, 0.31, 0.38); // #404f61 — active terminal
    } else if (is_active_project) {
        setLayerBgColor(wrapper_layer, 0.15, 0.19, 0.24); // #263040 — active project
    }
    // Nav highlight: blue left border to show keyboard selection
    if (is_nav_highlighted and !is_selected) {
        const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setBorderWidth(wrapper_layer, objc.sel("setBorderWidth:"), 1.0);
        const NSColor = objc.getClass("NSColor") orelse unreachable;
        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.29, 0.565, 0.851, 1.0);
        const cgColor = objc.msgSend(color, objc.sel("CGColor"));
        objc.msgSendVoid1(wrapper_layer, objc.sel("setBorderColor:"), cgColor);
        setLayerBgColor(wrapper_layer, 0.15, 0.19, 0.24); // slightly highlighted bg
    }

    // Position label inside wrapper at x=32, vertically centered
    // The wrapper is inside a FlippedView (y=0 is top), so increase y to push down
    const label_h: objc.CGFloat = 18.0;
    const label_y: objc.CGFloat = (height - label_h) / 2.0 - 1.0;
    setFrame(label, objc.sel("setFrame:"), objc.NSMakeRect(32, label_y, 200 - 32, label_h));
    objc.msgSendVoid1(wrapper, objc.sel("addSubview:"), label);

    // Show blue bell dot if this terminal has a pending notification
    const bell_session_idx = term_text_view.findSessionByTerminalId(terminal_id);
    if (bell_session_idx) |bsi| {
        if (bsi < term_text_view.bell_active.len and term_text_view.bell_active[bsi]) {
            const dot = newAutorelease(objc.getClass("NSView") orelse unreachable);
            setFrame(dot, objc.sel("setFrame:"), objc.NSMakeRect(18, (height - 8) / 2, 8, 8));
            setBool(dot, objc.sel("setWantsLayer:"), objc.YES);
            const dot_layer = objc.msgSend(dot, objc.sel("layer"));
            setLayerBgColor(dot_layer, 0.29, 0.565, 0.851); // blue #4a90d9
            const setCornerRadius: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
                @ptrCast(&objc.c.objc_msgSend);
            setCornerRadius(dot_layer, objc.sel("setCornerRadius:"), 4.0); // circle
            objc.msgSendVoid1(wrapper, objc.sel("addSubview:"), dot);
        }
    }

    // Show process status indicator for terminals with commands
    if (command != null) {
        const is_alive = term_text_view.isSessionAlive(terminal_id);
        const status_dot = newAutorelease(objc.getClass("NSView") orelse unreachable);
        const dot_size: objc.CGFloat = 6;
        const dot_x: objc.CGFloat = 200 - 24; // right-aligned with margin
        const dot_y: objc.CGFloat = (height - dot_size) / 2.0;
        setFrame(status_dot, objc.sel("setFrame:"), objc.NSMakeRect(dot_x, dot_y, dot_size, dot_size));
        setBool(status_dot, objc.sel("setWantsLayer:"), objc.YES);
        const status_layer = objc.msgSend(status_dot, objc.sel("layer"));
        if (is_alive) {
            setLayerBgColor(status_layer, 0.30, 0.75, 0.40); // green
        } else {
            setLayerBgColor(status_layer, 0.45, 0.50, 0.56); // gray
        }
        const setCorner: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setCorner(status_layer, objc.sel("setCornerRadius:"), dot_size / 2.0);
        // Tooltip shows the command and status
        if (command) |cmd| {
            var tip_buf: [256]u8 = undefined;
            const tip = if (is_alive)
                std.fmt.bufPrint(&tip_buf, "{s} (running)", .{cmd}) catch cmd
            else
                std.fmt.bufPrint(&tip_buf, "{s} (stopped)", .{cmd}) catch cmd;
            objc.msgSendVoid1(status_dot, objc.sel("setToolTip:"), objc.nsString(tip));
        }
        objc.msgSendVoid1(wrapper, objc.sel("addSubview:"), status_dot);
    }

    // Store info for the click handler
    const info_idx = term_row_info_count;
    if (info_idx < term_row_infos.len) {
        term_row_infos[info_idx] = .{
            .path = project_path,
            .command = command,
            .project_id = project_id,
            .terminal_id = terminal_id,
        };
        term_row_info_count += 1;
    }

    setRowInfoIdx(wrapper, info_idx);

    // Set up right-click context menu on wrapper
    const NSMenu = objc.getClass("NSMenu") orelse unreachable;
    const NSMenuItem = objc.getClass("NSMenuItem") orelse unreachable;
    const menu = newAutorelease(NSMenu);

    const setTag: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    const initItem: *const fn (objc.id, objc.SEL, objc.id, objc.SEL, objc.id) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const rename_item = initItem(
        newAutorelease(NSMenuItem),
        objc.sel("initWithTitle:action:keyEquivalent:"),
        objc.nsString("Edit"),
        objc.sel("editTerminal:"),
        objc.nsString(""),
    );
    setTag(rename_item, objc.sel("setTag:"), @intCast(info_idx));
    objc.msgSendVoid1(menu, objc.sel("addItem:"), rename_item);

    // Separator
    const sep_item = objc.msgSend(NSMenuItem, objc.sel("separatorItem"));
    objc.msgSendVoid1(menu, objc.sel("addItem:"), sep_item);

    // Delete
    const delete_item = initItem(
        newAutorelease(NSMenuItem),
        objc.sel("initWithTitle:action:keyEquivalent:"),
        objc.nsString("Delete"),
        objc.sel("deleteTerminal:"),
        objc.nsString(""),
    );
    setTag(delete_item, objc.sel("setTag:"), @intCast(info_idx));
    objc.msgSendVoid1(menu, objc.sel("addItem:"), delete_item);

    objc.msgSendVoid1(wrapper, objc.sel("setMenu:"), menu);

    return wrapper;
}

/// Navigate the sidebar selection up or down by `delta` items.
pub fn navigateSidebar(delta: i32) void {
    if (nav_item_count == 0) return;
    const count: i32 = @intCast(nav_item_count);

    if (selected_nav_index) |current| {
        const cur: i32 = @intCast(current);
        const next = @mod(cur + delta, count);
        selected_nav_index = @intCast(next);
    } else {
        selected_nav_index = if (delta > 0) 0 else @intCast(nav_item_count - 1);
    }

    // Only update visual highlight, do NOT change selected_terminal_index
    // The terminal only switches when the user presses ⌘Enter (activateSelectedSidebarItem)
    if (g_sidebar_app) |app| rebuildSidebar(app);
}

/// Activate (open) the currently selected sidebar item.
pub fn activateSelectedSidebarItem() void {
    const ni = selected_nav_index orelse return;
    if (ni >= nav_items.len) return;
    const item = nav_items[ni] orelse return;

    switch (item.kind) {
        .terminal => openTerminalAtIndex(item.index),
        .add_terminal => showAddTerminalDialog(item.index),
    }
}

/// Show add terminal dialog for the current project (⌘T).
/// Pre-populates name with "Terminal" so user can just press Enter.
pub fn showNewTerminalForCurrentProject() void {
    const application = g_sidebar_app orelse return;
    // Find current project from selected terminal
    var current_project_idx: ?usize = null;
    if (selected_terminal_index) |sel_idx| {
        var count: usize = 0;
        for (application.projects(), 0..) |proj, pi| {
            for (proj.terminals.items) |_| {
                if (count == sel_idx) {
                    current_project_idx = pi;
                    break;
                }
                count += 1;
            }
            if (current_project_idx != null) break;
        }
    }
    // Fall back to first project
    const proj_idx = current_project_idx orelse if (application.projects().len > 0) @as(usize, 0) else return;
    showAddTerminalDialogWithDefault(proj_idx, "Terminal");
}

/// Prevent re-entrant terminal opens (button can fire multiple times).
var opening_terminal: bool = false;

/// Called when a terminal row is clicked — opens the terminal in the main panel.
pub fn openTerminalAtIndex(index: usize) void {
    if (opening_terminal) return;
    opening_terminal = true;
    defer opening_terminal = false;

    // Save cwd of the terminal we're leaving
    term_text_view.saveActiveCwd();

    if (index >= term_row_infos.len) return;
    const info = term_row_infos[index] orelse return;
    const main_panel = window_ui.main_panel_view orelse return;

    // Update selection and rebuild sidebar to show highlight
    selected_terminal_index = index;
    if (g_sidebar_app) |app| rebuildSidebar(app);

    // Resolve effective cwd: saved cwd > project path
    const effective_cwd = blk: {
        const app2 = g_sidebar_app orelse break :blk info.path;
        for (app2.projects()) |proj| {
            if (std.mem.eql(u8, proj.id, info.project_id)) {
                for (proj.terminals.items) |t| {
                    if (std.mem.eql(u8, t.id, info.terminal_id)) {
                        if (t.cwd) |saved_cwd| {
                            // Check if directory still exists
                            std.fs.accessAbsolute(saved_cwd, .{}) catch break :blk info.path;
                            break :blk saved_cwd;
                        }
                        break;
                    }
                }
                break;
            }
        }
        break :blk info.path;
    };

    // Create or switch to session (keyed by terminal_id, not sidebar position)
    if (!term_text_view.getOrCreateSession(info.terminal_id, effective_cwd, info.command)) return;

    // Layout the session's split tree in the main panel
    term_text_view.layoutActiveSession(main_panel);

    // Update header with terminal name and git info
    // Find the terminal name from the info
    const app = g_sidebar_app orelse return;
    for (app.projects()) |proj| {
        if (std.mem.eql(u8, proj.id, info.project_id)) {
            for (proj.terminals.items) |t| {
                if (std.mem.eql(u8, t.id, info.terminal_id)) {
                    window_ui.updateHeader(t.name, proj.path);
                    break;
                }
            }
            break;
        }
    }

    // Rebuild sidebar again now that the session exists (updates status dots)
    if (g_sidebar_app) |app2| rebuildSidebar(app2);

    // Focus the active pane
    if (term_text_view.getFocusedView()) |focused_view| {
        const NSApp_class = objc.getClass("NSApplication") orelse return;
        const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
        const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));
        objc.msgSendVoid1(main_window, objc.sel("makeFirstResponder:"), focused_view);
    }
}

fn isAddTerminalSelected(project_id: []const u8) bool {
    const ni = selected_nav_index orelse return false;
    if (ni >= nav_items.len) return false;
    const item = nav_items[ni] orelse return false;
    if (item.kind != .add_terminal) return false;
    const app = g_sidebar_app orelse return false;
    const projs = app.projects();
    if (item.index >= projs.len) return false;
    return std.mem.eql(u8, projs[item.index].id, project_id);
}

fn createSeparatorLine(y_offset: objc.CGFloat) objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const sep = newAutorelease(NSView);
    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrame(sep, objc.sel("setFrame:"), objc.NSMakeRect(0, y_offset, 200, 1));
    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(sep, objc.sel("setWantsLayer:"), objc.YES);
    const layer = objc.msgSend(sep, objc.sel("layer"));
    setBackgroundColor(layer, 0.173, 0.204, 0.251); // #2c3440
    return sep;
}

fn createAddTerminalRow(project_id: []const u8, y_offset: objc.CGFloat, height: objc.CGFloat, is_active_project: bool) objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const row = newAutorelease(NSView);

    // Check if this add-terminal row is nav-highlighted
    const is_nav_highlighted = isAddTerminalSelected(project_id);

    const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrame(row, objc.sel("setFrame:"), objc.NSMakeRect(0, y_offset, 200, height));

    const setBoolH: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBoolH(row, objc.sel("setWantsLayer:"), objc.YES);
    const row_layer = objc.msgSend(row, objc.sel("layer"));
    if (is_active_project) {
        setLayerBgColor(row_layer, 0.15, 0.19, 0.24); // #263040 — active project
    }
    if (is_nav_highlighted) {
        const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setBorderWidth(row_layer, objc.sel("setBorderWidth:"), 1.0);
        const NSColor = objc.getClass("NSColor") orelse unreachable;
        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.29, 0.565, 0.851, 1.0);
        const cgColor = objc.msgSend(color, objc.sel("CGColor"));
        objc.msgSendVoid1(row_layer, objc.sel("setBorderColor:"), cgColor);
        setLayerBgColor(row_layer, 0.15, 0.19, 0.24);
    }

    // "+" button
    const NSButton = objc.getClass("NSButton") orelse unreachable;
    const btn = newAutorelease(NSButton);
    objc.msgSendVoid1(btn, objc.sel("setTitle:"), objc.nsString("+ Add Terminal"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(btn, objc.sel("setBordered:"), objc.NO);

    const NSFont = objc.getClass("NSFont") orelse unreachable;
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const font = sysFont(NSFont, objc.sel("systemFontOfSize:"), 11.0);
    objc.msgSendVoid1(btn, objc.sel("setFont:"), font);

    // Wire up the action with explicit delegate target
    objc.msgSendVoid1(btn, objc.sel("setAction:"), objc.sel("addTerminalToProject:"));
    if (window_ui.app_delegate) |delegate| {
        objc.msgSendVoid1(btn, objc.sel("setTarget:"), delegate);
    }

    // Store the project ID as the button's tag via associated object
    // We use a simpler approach: store in the button's tag (index into projects)
    // Find the project index
    if (g_sidebar_app) |app| {
        for (app.projects(), 0..) |proj, i| {
            if (std.mem.eql(u8, proj.id, project_id)) {
                const setTag: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setTag(btn, objc.sel("setTag:"), @intCast(i));
                break;
            }
        }
    }

    objc.msgSendVoid1(row, objc.sel("addSubview:"), btn);
    centerVertically(btn, row);
    pinLeading(btn, row, 32.0);

    return row;
}

/// Show a delete confirmation dialog for the terminal at the given info index.
pub fn showDeleteProjectDialog(project_index: usize) void {
    const application = g_sidebar_app orelse return;
    const projs = application.projects();
    if (project_index >= projs.len) return;
    const proj = projs[project_index];

    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));

    var msg_buf: [256]u8 = undefined;
    const msg = std.fmt.bufPrint(&msg_buf, "Delete project \"{s}\"?", .{proj.name}) catch "Delete project?";
    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString(msg));
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"),
        objc.nsString("This will remove the project from the sidebar and close all its terminals. The files on disk will not be affected."));

    // Set alert style to critical (warning icon)
    const setStyle: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setStyle(alert, objc.sel("setAlertStyle:"), 2); // NSAlertStyleCritical

    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Delete"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result != NSAlertFirstButtonReturn) return;

    // Find a terminal in another project to select after deletion
    var next_terminal_id: ?[]const u8 = null;
    if (selected_terminal_index != null) {
        // Try project above first, then below
        if (project_index > 0) {
            var pi: usize = project_index - 1;
            while (true) {
                const p = application.store.projects.items[pi];
                if (p.terminals.items.len > 0) {
                    next_terminal_id = p.terminals.items[p.terminals.items.len - 1].id;
                    break;
                }
                if (pi == 0) break;
                pi -= 1;
            }
        }
        if (next_terminal_id == null) {
            for (application.store.projects.items[project_index + 1 ..]) |p| {
                if (p.terminals.items.len > 0) {
                    next_terminal_id = p.terminals.items[0].id;
                    break;
                }
            }
        }
    }

    // Close all terminals for this project
    for (proj.terminals.items) |t| {
        term_text_view.destroySession(t.id);
    }

    // Remove the project
    _ = application.store.projects.orderedRemove(project_index);
    application.store.save() catch {};

    // Select neighbor or clear
    selected_terminal_index = null;
    selected_nav_index = null;
    rebuildSidebar(application);

    if (next_terminal_id) |neighbor_id| {
        for (term_row_infos, 0..) |tri, idx| {
            if (tri) |row_info| {
                if (std.mem.eql(u8, row_info.terminal_id, neighbor_id)) {
                    openTerminalAtIndex(idx);
                    return;
                }
            }
        }
    }
    // No neighbor — clear the main panel
    const window_ui2 = @import("window.zig");
    window_ui2.clearHeader();
}

pub fn showDeleteTerminalDialog(info_index: usize) void {
    const application = g_sidebar_app orelse return;
    if (info_index >= term_row_infos.len) return;
    const info = term_row_infos[info_index] orelse return;

    // Find terminal name for the message
    const proj = application.store.findById(info.project_id) orelse return;
    var term_name: []const u8 = "this terminal";
    for (proj.terminals.items) |t| {
        if (std.mem.eql(u8, t.id, info.terminal_id)) {
            term_name = t.name;
            break;
        }
    }

    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));

    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Delete Terminal"));

    var msg_buf: [256]u8 = undefined;
    const msg = std.fmt.bufPrint(&msg_buf, "Are you sure you want to delete \"{s}\"?", .{term_name}) catch "Are you sure?";
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"), objc.nsString(msg));

    // NSAlertStyleCritical = 2
    const setStyle: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setStyle(alert, objc.sel("setAlertStyle:"), 2);

    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Delete"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

    // Center over main window
    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));
    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid(alert_window, objc.sel("layoutIfNeeded"));

    const main_frame = objc.msgSendRect(main_window, objc.sel("frame"));
    const alert_frame = objc.msgSendRect(alert_window, objc.sel("frame"));
    const cx = main_frame.origin.x + (main_frame.size.width - alert_frame.size.width) / 2.0;
    const cy = main_frame.origin.y + (main_frame.size.height - alert_frame.size.height) / 2.0;
    const setFrameOrigin: *const fn (objc.id, objc.SEL, objc.NSPoint) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameOrigin(alert_window, objc.sel("setFrameOrigin:"), .{ .x = cx, .y = cy });

    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result != NSAlertFirstButtonReturn) return;

    // Determine neighbor to select before deleting (above first, then below)
    var next_terminal_id: ?[]const u8 = null;
    const is_active = if (selected_terminal_index) |sel| sel == info_index else false;
    if (is_active) {
        // Look for terminal above (lower index)
        if (info_index > 0) {
            var i: usize = info_index - 1;
            while (true) {
                if (term_row_infos[i]) |neighbor| {
                    next_terminal_id = neighbor.terminal_id;
                    break;
                }
                if (i == 0) break;
                i -= 1;
            }
        }
        // If none above, look below
        if (next_terminal_id == null) {
            var i: usize = info_index + 1;
            while (i < term_row_infos.len) : (i += 1) {
                if (term_row_infos[i]) |neighbor| {
                    next_terminal_id = neighbor.terminal_id;
                    break;
                }
            }
        }
    }

    // Delete the terminal
    _ = application.store.deleteTerminal(info.project_id, info.terminal_id) catch {};

    // Destroy the terminal session if it exists
    term_text_view.destroySession(info.terminal_id);

    // Select neighbor or clear
    selected_terminal_index = null;
    selected_nav_index = null;

    // Rebuild sidebar first so term_row_infos reflects the deletion
    rebuildSidebar(application);

    if (is_active) {
        // Open the neighbor terminal if we found one
        if (next_terminal_id) |neighbor_id| {
            for (term_row_infos, 0..) |tri, idx| {
                if (tri) |row_info| {
                    if (std.mem.eql(u8, row_info.terminal_id, neighbor_id)) {
                        openTerminalAtIndex(idx);
                        return;
                    }
                }
            }
        }
        // No neighbor — clear the main panel
        const window_ui2 = @import("window.zig");
        window_ui2.clearHeader();
    } else {
        // Deleted a non-active terminal — re-select the previously active one
        // by finding it in the rebuilt term_row_infos
        if (term_text_view.getActiveTerminalId()) |active_tid| {
            for (term_row_infos, 0..) |tri, idx| {
                if (tri) |row_info| {
                    if (std.mem.eql(u8, row_info.terminal_id, active_tid)) {
                        selected_terminal_index = idx;
                        break;
                    }
                }
            }
        }
        rebuildSidebar(application);
    }
}

/// Show an edit dialog for the terminal at the given info index (same layout as Add Terminal).
pub fn showEditTerminalDialog(info_index: usize) void {
    const application = g_sidebar_app orelse return;
    if (info_index >= term_row_infos.len) return;
    const info = term_row_infos[info_index] orelse return;

    // Find current terminal data to pre-fill
    const proj = application.store.findById(info.project_id) orelse return;
    var current_name: []const u8 = "";
    var current_command: []const u8 = "";
    for (proj.terminals.items) |t| {
        if (std.mem.eql(u8, t.id, info.terminal_id)) {
            current_name = t.name;
            current_command = if (t.command) |c| c else "";
            break;
        }
    }

    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));

    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Edit Terminal"));
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"),
        objc.nsString("Edit the name and startup command."));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Save"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

    const NSView = objc.getClass("NSView") orelse return;
    const NSTextField = objc.getClass("NSTextField") orelse return;

    const accessory = objc.msgSend(NSView, objc.sel("new"));
    const setFrameFn: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameFn(accessory, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 320, 80));

    // Name label + field
    const name_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Name:"));
    setFrameFn(name_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 52, 70, 20));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_label);

    const name_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(name_field, objc.sel("setFrame:"), objc.NSMakeRect(76, 50, 240, 24));
    objc.msgSendVoid1(name_field, objc.sel("setStringValue:"), objc.nsString(current_name));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_field);

    // Command label + field
    const cmd_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Command:"));
    setFrameFn(cmd_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 14, 70, 20));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_label);

    const cmd_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(cmd_field, objc.sel("setFrame:"), objc.NSMakeRect(76, 12, 240, 24));
    objc.msgSendVoid1(cmd_field, objc.sel("setStringValue:"), objc.nsString(current_command));
    objc.msgSendVoid1(cmd_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. npm run dev"));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_field);

    objc.msgSendVoid1(alert, objc.sel("setAccessoryView:"), accessory);

    // Center over main window
    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));
    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid1(alert_window, objc.sel("setInitialFirstResponder:"), name_field);
    objc.msgSendVoid(alert_window, objc.sel("layoutIfNeeded"));

    const main_frame = objc.msgSendRect(main_window, objc.sel("frame"));
    const alert_frame = objc.msgSendRect(alert_window, objc.sel("frame"));
    const cx = main_frame.origin.x + (main_frame.size.width - alert_frame.size.width) / 2.0;
    const cy = main_frame.origin.y + (main_frame.size.height - alert_frame.size.height) / 2.0;
    const setFrameOrigin: *const fn (objc.id, objc.SEL, objc.NSPoint) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameOrigin(alert_window, objc.sel("setFrameOrigin:"), .{ .x = cx, .y = cy });

    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result != NSAlertFirstButtonReturn) return;

    // Read values
    const name_nsstr = objc.msgSend(name_field, objc.sel("stringValue"));
    const name_utf8: [*:0]const u8 = @ptrCast(objc.msgSend(name_nsstr, objc.sel("UTF8String")));
    const name = std.mem.span(name_utf8);

    const cmd_nsstr = objc.msgSend(cmd_field, objc.sel("stringValue"));
    const cmd_utf8: [*:0]const u8 = @ptrCast(objc.msgSend(cmd_nsstr, objc.sel("UTF8String")));
    const cmd = std.mem.span(cmd_utf8);

    if (name.len == 0) return;

    // Update name
    _ = application.store.renameTerminal(info.project_id, info.terminal_id, name) catch {};

    // Update command — need to find and modify the terminal directly
    if (application.store.findById(info.project_id)) |p| {
        for (p.terminals.items) |*t| {
            if (std.mem.eql(u8, t.id, info.terminal_id)) {
                if (cmd.len > 0) {
                    t.command = application.store.allocator.dupe(u8, cmd) catch null;
                } else {
                    t.command = null;
                }
                break;
            }
        }
        application.store.save() catch {};
    }

    rebuildSidebar(application);
}

pub fn showAddTerminalDialog(project_index: usize) void {
    showAddTerminalDialogWithDefault(project_index, "");
}

fn showAddTerminalDialogWithDefault(project_index: usize, default_name: []const u8) void {
    const application = g_sidebar_app orelse return;
    const projs = application.projects();
    if (project_index >= projs.len) return;
    const proj = projs[project_index];

    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));

    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Add Terminal"));
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"),
        objc.nsString("Enter a name and optional startup command."));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Add"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Cancel"));

    // Create accessory view with two labeled text fields, more spacing
    const NSView = objc.getClass("NSView") orelse return;
    const NSTextField = objc.getClass("NSTextField") orelse return;

    const accessory = objc.msgSend(NSView, objc.sel("new"));
    const setFrameFn: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameFn(accessory, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 320, 80));

    // Name label + field (top row)
    const name_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Name:"));
    setFrameFn(name_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 52, 70, 20));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_label);

    const name_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(name_field, objc.sel("setFrame:"), objc.NSMakeRect(76, 50, 240, 24));
    if (default_name.len > 0) {
        objc.msgSendVoid1(name_field, objc.sel("setStringValue:"), objc.nsString(default_name));
    } else {
        objc.msgSendVoid1(name_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. Dev Server"));
    }
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_field);

    // Command label + field (bottom row, 30px gap)
    const cmd_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Command:"));
    setFrameFn(cmd_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 14, 70, 20));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_label);

    const cmd_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(cmd_field, objc.sel("setFrame:"), objc.NSMakeRect(76, 12, 240, 24));
    objc.msgSendVoid1(cmd_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. npm run dev"));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_field);

    objc.msgSendVoid1(alert, objc.sel("setAccessoryView:"), accessory);

    // Run as sheet on the main window (centered over app)
    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));

    // Make name field first responder
    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid1(alert_window, objc.sel("setInitialFirstResponder:"), name_field);

    // Layout the alert so it knows its size, then center over main window
    objc.msgSendVoid(alert_window, objc.sel("layoutIfNeeded"));
    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const main_frame = objc.msgSendRect(main_window, objc.sel("frame"));
    const alert_frame = objc.msgSendRect(alert_window, objc.sel("frame"));
    const cx = main_frame.origin.x + (main_frame.size.width - alert_frame.size.width) / 2.0;
    const cy = main_frame.origin.y + (main_frame.size.height - alert_frame.size.height) / 2.0;
    const setFrameOrigin: *const fn (objc.id, objc.SEL, objc.NSPoint) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameOrigin(alert_window, objc.sel("setFrameOrigin:"), .{ .x = cx, .y = cy });
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result != NSAlertFirstButtonReturn) return;

    // Read values
    const name_nsstr = objc.msgSend(name_field, objc.sel("stringValue"));
    const name_utf8: [*:0]const u8 = @ptrCast(objc.msgSend(name_nsstr, objc.sel("UTF8String")));
    const name = std.mem.span(name_utf8);

    const cmd_nsstr = objc.msgSend(cmd_field, objc.sel("stringValue"));
    const cmd_utf8: [*:0]const u8 = @ptrCast(objc.msgSend(cmd_nsstr, objc.sel("UTF8String")));
    const cmd = std.mem.span(cmd_utf8);

    if (name.len == 0) return;

    const command: ?[]const u8 = if (cmd.len > 0) cmd else null;
    _ = application.store.addTerminal(proj.id, name, command) catch return;
    rebuildSidebar(application);
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const EdgeOptions = struct {
    top: bool = true,
    bottom: bool = true,
    leading: bool = true,
    trailing: bool = true,
};

fn pinToEdges(child: objc.id, parent: objc.id, opts: EdgeOptions) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    if (opts.top) {
        const c_anchor = objc.msgSend(child, objc.sel("topAnchor"));
        const p_anchor = objc.msgSend(parent, objc.sel("topAnchor"));
        const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), p_anchor);
        activate(constraint, objc.sel("setActive:"), objc.YES);
    }
    if (opts.bottom) {
        const c_anchor = objc.msgSend(child, objc.sel("bottomAnchor"));
        const p_anchor = objc.msgSend(parent, objc.sel("bottomAnchor"));
        const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), p_anchor);
        activate(constraint, objc.sel("setActive:"), objc.YES);
    }
    if (opts.leading) {
        const c_anchor = objc.msgSend(child, objc.sel("leadingAnchor"));
        const p_anchor = objc.msgSend(parent, objc.sel("leadingAnchor"));
        const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), p_anchor);
        activate(constraint, objc.sel("setActive:"), objc.YES);
    }
    if (opts.trailing) {
        const c_anchor = objc.msgSend(child, objc.sel("trailingAnchor"));
        const p_anchor = objc.msgSend(parent, objc.sel("trailingAnchor"));
        const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), p_anchor);
        activate(constraint, objc.sel("setActive:"), objc.YES);
    }
}

fn pinTopToBottom(child: objc.id, above: objc.id) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const c_anchor = objc.msgSend(child, objc.sel("topAnchor"));
    const a_anchor = objc.msgSend(above, objc.sel("bottomAnchor"));
    const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), a_anchor);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn setHeight(view: objc.id, height: objc.CGFloat) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(view, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const anchor = objc.msgSend(view, objc.sel("heightAnchor"));
    const constraintEq: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const constraint = constraintEq(anchor, objc.sel("constraintEqualToConstant:"), height);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn centerVertically(child: objc.id, parent: objc.id) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const c_anchor = objc.msgSend(child, objc.sel("centerYAnchor"));
    const p_anchor = objc.msgSend(parent, objc.sel("centerYAnchor"));
    const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), p_anchor);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn pinLeading(child: objc.id, parent: objc.id, constant: objc.CGFloat) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const c_anchor = objc.msgSend(child, objc.sel("leadingAnchor"));
    const p_anchor = objc.msgSend(parent, objc.sel("leadingAnchor"));
    const constraintFn: *const fn (objc.id, objc.SEL, objc.id, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const constraint = constraintFn(c_anchor, objc.sel("constraintEqualToAnchor:constant:"), p_anchor, constant);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn pinTrailing(child: objc.id, parent: objc.id, constant: objc.CGFloat) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const c_anchor = objc.msgSend(child, objc.sel("trailingAnchor"));
    const p_anchor = objc.msgSend(parent, objc.sel("trailingAnchor"));
    const constraintFn: *const fn (objc.id, objc.SEL, objc.id, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const constraint = constraintFn(c_anchor, objc.sel("constraintEqualToAnchor:constant:"), p_anchor, constant);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn removeAllSubviews(view: objc.id) void {
    const subviews = objc.msgSend(view, objc.sel("subviews"));
    objc.msgSendVoid1(subviews, objc.sel("makeObjectsPerformSelector:"), objc.sel("removeFromSuperview"));
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

fn setLayerBgColor(layer: objc.id, r: f64, g: f64, b: f64) void {
    setBackgroundColor(layer, r, g, b);
}

fn setBackgroundColor(layer: objc.id, r: f64, g: f64, b: f64) void {
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), r, g, b, 1.0);
    const cgColor = objc.msgSend(color, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), cgColor);
}

fn setTextColor(field: objc.id, r: f64, g: f64, b: f64) void {
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), r, g, b, 1.0);
    objc.msgSendVoid1(field, objc.sel("setTextColor:"), color);
}

fn setBorderBottom(layer: objc.id) void {
    const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBorderWidth(layer, objc.sel("setBorderWidth:"), 1.0);

    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.173, 0.204, 0.251, 1.0);
    const cgColor = objc.msgSend(color, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), cgColor);
}

// ---------------------------------------------------------------------------
// Stats bar (CPU + Memory at bottom of sidebar)
// ---------------------------------------------------------------------------

fn pinBottomToTop(child: objc.id, below: objc.id) void {
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    const c_anchor = objc.msgSend(child, objc.sel("bottomAnchor"));
    const b_anchor = objc.msgSend(below, objc.sel("topAnchor"));
    const constraint = objc.msgSend1(c_anchor, objc.sel("constraintEqualToAnchor:"), b_anchor);
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(constraint, objc.sel("setActive:"), objc.YES);
}

fn createStatsBar() objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const bar = objc.msgSend(NSView, objc.sel("new"));
    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(bar, objc.sel("setWantsLayer:"), objc.YES);
    const layer = objc.msgSend(bar, objc.sel("layer"));
    setBackgroundColor(layer, 0.09, 0.114, 0.149); // match sidebar bg

    // Separator line at top of stats bar
    const sep = objc.msgSend(NSView, objc.sel("new"));
    setBool(sep, objc.sel("setWantsLayer:"), objc.YES);
    const sep_layer = objc.msgSend(sep, objc.sel("layer"));
    setBackgroundColor(sep_layer, 0.173, 0.204, 0.251); // #2c3440
    objc.msgSendVoid1(bar, objc.sel("addSubview:"), sep);
    pinToEdges(sep, bar, .{ .bottom = false });
    setHeight(sep, 1.0);

    // Label
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(""));
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(label, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    setTextColor(label, 0.45, 0.5, 0.55);

    const setAlign: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlign(label, objc.sel("setAlignment:"), 1); // NSTextAlignmentCenter

    // Set initial attributed string with kerning
    setStatsAttributedString(label, "CPU 0%  •  MEM 0MB");

    objc.msgSendVoid1(bar, objc.sel("addSubview:"), label);

    // Center label vertically in bar
    const setTranslates2: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates2(label, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);
    // Leading/trailing
    const activate2: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    const lc = objc.msgSend1(objc.msgSend(label, objc.sel("leadingAnchor")), objc.sel("constraintEqualToAnchor:"), objc.msgSend(bar, objc.sel("leadingAnchor")));
    activate2(lc, objc.sel("setActive:"), objc.YES);
    const tc = objc.msgSend1(objc.msgSend(label, objc.sel("trailingAnchor")), objc.sel("constraintEqualToAnchor:"), objc.msgSend(bar, objc.sel("trailingAnchor")));
    activate2(tc, objc.sel("setActive:"), objc.YES);
    // Center Y
    const cy = objc.msgSend1(objc.msgSend(label, objc.sel("centerYAnchor")), objc.sel("constraintEqualToAnchor:"), objc.msgSend(bar, objc.sel("centerYAnchor")));
    activate2(cy, objc.sel("setActive:"), objc.YES);

    stats_label = label;

    return bar;
}

var last_cpu_time_ns: i128 = 0;
var last_wall_time_ns: i128 = 0;
var last_cpu_pct: u32 = 0;

/// Update the stats bar with current CPU and memory usage.
/// Called from the poll timer every ~10 seconds.
pub fn updateStats() void {
    const label = stats_label orelse return;

    // Get memory via rusage
    const rusage = std.posix.getrusage(0); // RUSAGE_SELF
    const mem_mb = @divTrunc(rusage.maxrss, 1024 * 1024); // maxrss is in bytes on macOS

    // Get CPU percentage since last sample
    const clock = std.posix.clock_gettime(.PROCESS_CPUTIME_ID) catch return;
    const wall = std.posix.clock_gettime(.MONOTONIC) catch return;
    const cpu_ns: i128 = @as(i128, clock.sec) * 1_000_000_000 + clock.nsec;
    const wall_ns: i128 = @as(i128, wall.sec) * 1_000_000_000 + wall.nsec;

    if (last_wall_time_ns > 0) {
        const cpu_delta = cpu_ns - last_cpu_time_ns;
        const wall_delta = wall_ns - last_wall_time_ns;
        if (wall_delta > 0) {
            last_cpu_pct = @intCast(@min(@divTrunc(cpu_delta * 100, wall_delta), 100));
        }
    }
    last_cpu_time_ns = cpu_ns;
    last_wall_time_ns = wall_ns;

    // Format string
    var buf: [64]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "CPU {d}%  •  MEM {d}MB", .{
        last_cpu_pct,
        mem_mb,
    }) catch return;

    // Update label with kerning
    setStatsAttributedString(label, text);
}

fn setStatsAttributedString(label: objc.id, text: []const u8) void {
    const NSMutableAttributedString = objc.getClass("NSMutableAttributedString") orelse return;
    const NSFont = objc.getClass("NSFont") orelse return;
    const NSNumber = objc.getClass("NSNumber") orelse return;

    const ns_str = objc.nsString(text);

    const initWith: *const fn (objc.id, objc.SEL, objc.id) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const attr_str = initWith(
        objc.msgSend(NSMutableAttributedString, objc.sel("alloc")),
        objc.sel("initWithString:"),
        ns_str,
    );

    // Build range {0, length}
    const NSRange = extern struct { location: u64, length: u64 };
    const length = objc.msgSendUInt(attr_str, objc.sel("length"));
    const range: NSRange = .{ .location = 0, .length = length };

    const addAttr: *const fn (objc.id, objc.SEL, objc.id, objc.id, NSRange) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    // Set font
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const font = sysFont(NSFont, objc.sel("systemFontOfSize:"), 10.0);
    addAttr(attr_str, objc.sel("addAttribute:value:range:"), objc.nsString("NSFont"), font, range);

    // Set kern (character spacing)
    const numberWith: *const fn (objc.id, objc.SEL, f64) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const kern = numberWith(NSNumber, objc.sel("numberWithDouble:"), 1.1);
    addAttr(attr_str, objc.sel("addAttribute:value:range:"), objc.nsString("NSKern"), kern, range);

    // Set text color
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const color = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.45, 0.5, 0.55, 1.0);
    addAttr(attr_str, objc.sel("addAttribute:value:range:"), objc.nsString("NSColor"), color, range);

    // Set paragraph style for center alignment
    const NSMutableParagraphStyle = objc.getClass("NSMutableParagraphStyle") orelse return;
    const para = objc.msgSend(NSMutableParagraphStyle, objc.sel("new"));
    const setAlignment: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlignment(para, objc.sel("setAlignment:"), 1); // NSTextAlignmentCenter
    addAttr(attr_str, objc.sel("addAttribute:value:range:"), objc.nsString("NSParagraphStyle"), para, range);

    objc.msgSendVoid1(label, objc.sel("setAttributedStringValue:"), attr_str);
}
