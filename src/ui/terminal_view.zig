/// Terminal view — renders the split tree for the active tab using NSSplitView.
///
/// Each tab's SplitTree is recursively mapped to a hierarchy of NSSplitViews:
///   - Leaf node → NSView hosting the ghostty Metal layer
///   - Split node → NSSplitView with two children
///
/// The focused pane gets a subtle blue border (like the Electron version).
const std = @import("std");
const objc = @import("../objc.zig");
const app_mod = @import("../app.zig");
const terminal = @import("../terminal.zig");
const ghostty = @import("../ghostty.zig");

/// The NSView that holds the terminal host area (set during window creation).
var terminal_host_view: ?objc.id = null;

/// The tab bar view (NSStackView of buttons at the top).
var tab_bar_view: ?objc.id = null;

/// Store reference to the host view.
pub fn setTerminalHostView(view: objc.id) void {
    terminal_host_view = view;
}

/// Store reference to the tab bar container.
pub fn setTabBarView(view: objc.id) void {
    tab_bar_view = view;
}

// ---------------------------------------------------------------------------
// Split view construction
// ---------------------------------------------------------------------------

/// Rebuild the entire split view hierarchy for the active session's active tab.
pub fn rebuildSplitViews(application: *app_mod.App) void {
    const host = terminal_host_view orelse return;
    const session = application.activeSession() orelse return;
    const tab = session.activeTab() orelse return;

    // Remove all existing subviews from the host
    removeAllSubviews(host);

    // Recursively build the NSSplitView tree
    const view = buildViewForNode(tab.root, tab.focused_leaf_id);
    objc.msgSendVoid1(host, objc.sel("addSubview:"), view);

    // Make the new view fill the host
    fillParent(view, host);
}

/// Update only the focus indicator (border) without rebuilding the tree.
pub fn updateFocusIndicator(application: *app_mod.App) void {
    const session = application.activeSession() orelse return;
    const tab = session.activeTab() orelse return;
    updateFocusInTree(tab.root, tab.focused_leaf_id);
}

/// Rebuild the tab bar for the active session.
pub fn rebuildTabBar(application: *app_mod.App) void {
    const bar = tab_bar_view orelse return;
    removeAllSubviews(bar);

    const session = application.activeSession() orelse return;
    if (session.tabs.items.len <= 1) {
        // Hide bar when there's only one tab
        const setHidden: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setHidden(bar, objc.sel("setHidden:"), objc.YES);
        return;
    }

    const setHidden: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setHidden(bar, objc.sel("setHidden:"), objc.NO);

    const NSButton = objc.getClass("NSButton") orelse return;

    for (session.tabs.items, 0..) |tab, i| {
        const title = objc.nsString(tab.label);
        const btn = objc.msgSend1(NSButton, objc.sel("buttonWithTitle:target:action:"), title);

        // Highlight the active tab
        if (i == session.active_tab) {
            setBorderForView(btn, true);
        }

        objc.msgSendVoid1(bar, objc.sel("addArrangedSubview:"), btn);
    }
}

// ---------------------------------------------------------------------------
// Recursive view builder
// ---------------------------------------------------------------------------

fn buildViewForNode(node: *terminal.SplitNode, focused_id: u32) objc.id {
    switch (node.*) {
        .leaf => |*leaf| {
            return createLeafView(leaf, leaf.id == focused_id);
        },
        .split => |split| {
            return createSplitViewFromNode(split, focused_id);
        },
    }
}

/// Create an NSView that hosts a ghostty surface's Metal layer.
fn createLeafView(leaf: *terminal.Leaf, focused: bool) objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const view = objc.msgSend(NSView, objc.sel("new"));

    // Set wantsLayer = YES so we can add a Metal sublayer
    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(view, objc.sel("setWantsLayer:"), objc.YES);

    // Get the Metal layer from ghostty and add it
    if (ghostty.surfaceMetalLayer(leaf.surface)) |metal_layer| {
        const layer = objc.msgSend(view, objc.sel("layer"));
        objc.msgSendVoid1(layer, objc.sel("addSublayer:"), @as(objc.id, @ptrCast(metal_layer)));
    }

    // Store the view reference so we can find it later
    leaf.view = view;

    // Focus border
    setBorderForView(view, focused);

    // Focus the surface if this is the focused leaf
    ghostty.surfaceSetFocus(leaf.surface, focused);

    return view;
}

/// Create an NSSplitView from a Split node.
fn createSplitViewFromNode(split: terminal.Split, focused_id: u32) objc.id {
    const NSSplitView = objc.getClass("NSSplitView") orelse unreachable;
    const split_view = objc.msgSend(NSSplitView, objc.sel("new"));

    // Set orientation
    const setVertical: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    // NSSplitView: vertical=YES → side-by-side (our "horizontal" split)
    const is_vertical: objc.BOOL = if (split.direction == .horizontal) objc.YES else objc.NO;
    setVertical(split_view, objc.sel("setVertical:"), is_vertical);

    // Thin divider
    const setDivider: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setDivider(split_view, objc.sel("setDividerStyle:"), 1); // NSSplitViewDividerStyleThin

    // Build children
    const first_view = buildViewForNode(split.first, focused_id);
    const second_view = buildViewForNode(split.second, focused_id);

    objc.msgSendVoid1(split_view, objc.sel("addSubview:"), first_view);
    objc.msgSendVoid1(split_view, objc.sel("addSubview:"), second_view);

    // Set divider position based on ratio
    // We need to do this after layout, but we can set it immediately
    // and let the split view adjust
    const setPosition: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);

    const frame = objc.msgSendRect(split_view, objc.sel("frame"));
    const total = if (split.direction == .horizontal) frame.size.width else frame.size.height;
    const position = total * split.ratio;
    setPosition(split_view, objc.sel("setPosition:ofDividerAtIndex:"), position, 0);

    return split_view;
}

// ---------------------------------------------------------------------------
// Focus management
// ---------------------------------------------------------------------------

fn updateFocusInTree(node: *terminal.SplitNode, focused_id: u32) void {
    switch (node.*) {
        .leaf => |leaf| {
            const is_focused = leaf.id == focused_id;
            if (leaf.view) |view| {
                setBorderForView(view, is_focused);
            }
            ghostty.surfaceSetFocus(leaf.surface, is_focused);
        },
        .split => |split| {
            updateFocusInTree(split.first, focused_id);
            updateFocusInTree(split.second, focused_id);
        },
    }
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

fn removeAllSubviews(view: objc.id) void {
    // [[view subviews] makeObjectsPerformSelector:@selector(removeFromSuperview)]
    const subviews = objc.msgSend(view, objc.sel("subviews"));
    objc.msgSendVoid1(subviews, objc.sel("makeObjectsPerformSelector:"), objc.sel("removeFromSuperview"));
}

fn fillParent(child: objc.id, parent: objc.id) void {
    // Use autoresizing mask to fill parent
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(child, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    // Add constraints: child edges = parent edges
    const addConstraints = struct {
        fn add(c: objc.id, p: objc.id) void {
            const attrs = [_][]const u8{ "leadingAnchor", "trailingAnchor", "topAnchor", "bottomAnchor" };
            for (attrs) |attr| {
                const child_anchor = objc.msgSend(c, objc.sel(@ptrCast(attr.ptr)));
                const parent_anchor = objc.msgSend(p, objc.sel(@ptrCast(attr.ptr)));
                const constraint = objc.msgSend1(child_anchor, objc.sel("constraintEqualToAnchor:"), parent_anchor);
                const setActive: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
                    @ptrCast(&objc.c.objc_msgSend);
                setActive(constraint, objc.sel("setActive:"), objc.YES);
            }
        }
    };
    addConstraints.add(child, parent);
}

fn setBorderForView(view: objc.id, focused: bool) void {
    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(view, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(view, objc.sel("layer"));

    // Border width
    const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBorderWidth(layer, objc.sel("setBorderWidth:"), if (focused) 1.0 else 0.0);

    if (focused) {
        // Blue border color: #4a90d9
        const NSColor = objc.getClass("NSColor") orelse return;
        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const color = colorWith(
            NSColor,
            objc.sel("colorWithRed:green:blue:alpha:"),
            0.29, // 74/255
            0.565, // 144/255
            0.851, // 217/255
            1.0,
        );
        const cgColor = objc.msgSend(color, objc.sel("CGColor"));
        objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), cgColor);
    }
}
