/// macOS AppKit main window — sets up the app, window, menu bar, and root split view.
///
/// Layout:
///   ┌─────────────┬───────────────────────────────┐
///   │  Sidebar    │  Main Panel                   │
///   │  (projects  │  (terminal split tree)         │
///   │   + terms)  │                               │
///   └─────────────┴───────────────────────────────┘
const std = @import("std");
const objc = @import("../objc.zig");
const app_mod = @import("../app.zig");
const sidebar = @import("sidebar.zig");
const term_text_view = @import("term_text_view.zig");

// AppKit constants
const NSWindowStyleMaskTitled: objc.NSUInteger = 1 << 0;
const NSWindowStyleMaskClosable: objc.NSUInteger = 1 << 1;
const NSWindowStyleMaskMiniaturizable: objc.NSUInteger = 1 << 2;
const NSWindowStyleMaskResizable: objc.NSUInteger = 1 << 3;
const NSBackingStoreBuffered: objc.NSUInteger = 2;
const NSSplitViewDividerStyleThin: objc.NSInteger = 1;

/// Global pointer so ObjC callbacks can reach our app.
var g_app: ?*app_mod.App = null;

/// The main content panel (right side of the split).
pub var main_panel_view: ?objc.id = null;

/// The app delegate instance (for explicit action targeting).
pub var app_delegate: ?objc.id = null;

/// Header bar above the terminal area (44px, matches sidebar header).
pub var header_view: ?objc.id = null;
pub var header_name_label: ?objc.id = null;
pub var header_git_label: ?objc.id = null;
pub var header_git_changes_label: ?objc.id = null;

pub const HEADER_HEIGHT: objc.CGFloat = 44.0;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/// Launch the macOS application run loop.
pub fn launchApp(application: *app_mod.App) void {
    g_app = application;

    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));

    const setPolicy: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setPolicy(nsapp, objc.sel("setActivationPolicy:"), 0); // NSApplicationActivationPolicyRegular

    const delegate_class = registerDelegateClass() orelse return;
    const delegate = objc.msgSend(delegate_class, objc.sel("new"));
    app_delegate = delegate;
    objc.msgSendVoid1(nsapp, objc.sel("setDelegate:"), delegate);

    createMainMenu(nsapp);
    objc.msgSendVoid(nsapp, objc.sel("run"));
}

// -------------------------------------------------------------------------
// App delegate class
// -------------------------------------------------------------------------

fn registerDelegateClass() ?objc.id {
    const NSObject = objc.getClass("NSObject") orelse return null;
    const cls = objc.allocateClassPair(NSObject, "MyTermAppDelegate") orelse return null;

    // Lifecycle
    _ = objc.addMethod(cls, objc.sel("applicationDidFinishLaunching:"), &appDidFinishLaunching, "v@:@");
    _ = objc.addMethod(cls, objc.sel("applicationShouldTerminateAfterLastWindowClosed:"), &shouldTerminate, "B@:@");
    _ = objc.addMethod(cls, objc.sel("applicationWillTerminate:"), &appWillTerminate, "v@:@");

    // Terminal split actions
    _ = objc.addMethod(cls, objc.sel("splitHorizontal:"), &onSplitHorizontal, "v@:@");
    _ = objc.addMethod(cls, objc.sel("splitVertical:"), &onSplitVertical, "v@:@");
    _ = objc.addMethod(cls, objc.sel("closePane:"), &onClosePane, "v@:@");
    _ = objc.addMethod(cls, objc.sel("focusNextPane:"), &onFocusNextPane, "v@:@");
    _ = objc.addMethod(cls, objc.sel("focusPrevPane:"), &onFocusPrevPane, "v@:@");
    _ = objc.addMethod(cls, objc.sel("increaseFontSize:"), &onIncreaseFontSize, "v@:@");
    _ = objc.addMethod(cls, objc.sel("decreaseFontSize:"), &onDecreaseFontSize, "v@:@");

    _ = objc.addMethod(cls, objc.sel("newTerminal:"), &onNewTerminal, "v@:@");

    // Sidebar actions
    _ = objc.addMethod(cls, objc.sel("sidebarNext:"), &onSidebarNext, "v@:@");
    _ = objc.addMethod(cls, objc.sel("sidebarPrev:"), &onSidebarPrev, "v@:@");
    _ = objc.addMethod(cls, objc.sel("sidebarActivate:"), &onSidebarActivate, "v@:@");
    _ = objc.addMethod(cls, objc.sel("addProject:"), &onAddProject, "v@:@");
    _ = objc.addMethod(cls, objc.sel("addTerminalToProject:"), &onAddTerminalToProject, "v@:@");
    _ = objc.addMethod(cls, objc.sel("openTerminal:"), &onOpenTerminal, "v@:@");
    _ = objc.addMethod(cls, objc.sel("editTerminal:"), &onEditTerminal, "v@:@");
    _ = objc.addMethod(cls, objc.sel("deleteTerminal:"), &onDeleteTerminal, "v@:@");

    objc.registerClassPair(cls);
    return cls;
}

// -------------------------------------------------------------------------
// Lifecycle callbacks
// -------------------------------------------------------------------------

fn appDidFinishLaunching(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    const application = g_app orelse return;

    const NSWindow = objc.getClass("NSWindow") orelse return;
    const style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;

    const initWindow: *const fn (objc.id, objc.SEL, objc.NSRect, objc.NSUInteger, objc.NSUInteger, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const window = initWindow(
        objc.msgSend(NSWindow, objc.sel("alloc")),
        objc.sel("initWithContentRect:styleMask:backing:defer:"),
        objc.NSMakeRect(100, 100, 1200, 760),
        style,
        NSBackingStoreBuffered,
        objc.NO,
    );

    objc.msgSendVoid1(window, objc.sel("setTitle:"), objc.nsString(""));

    // Transparent title bar blending with dark content
    const setBoolW: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBoolW(window, objc.sel("setTitlebarAppearsTransparent:"), objc.YES);
    const setTitleVis: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTitleVis(window, objc.sel("setTitleVisibility:"), 1); // NSWindowTitleHidden

    // Dark window background so title bar area is dark
    const NSColor = objc.getClass("NSColor") orelse return;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const darkBg = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.09, 0.114, 0.149, 1.0);
    objc.msgSendVoid1(window, objc.sel("setBackgroundColor:"), darkBg);

    const setAutosave: *const fn (objc.id, objc.SEL, objc.id) callconv(.c) objc.BOOL =
        @ptrCast(&objc.c.objc_msgSend);
    _ = setAutosave(window, objc.sel("setFrameAutosaveName:"), objc.nsString("MyTermMainWindow"));

    const setMinSize: *const fn (objc.id, objc.SEL, objc.NSSize) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setMinSize(window, objc.sel("setMinSize:"), .{ .width = 900, .height = 600 });

    // Root split: sidebar | main panel
    const root_split = createSplitView();
    const sidebar_view = sidebar.createSidebarView();
    sidebar.rebuildSidebar(application);
    const main_view = createMainPanel();
    main_panel_view = main_view;

    objc.msgSendVoid1(root_split, objc.sel("addSubview:"), sidebar_view);
    objc.msgSendVoid1(root_split, objc.sel("addSubview:"), main_view);

    // Constrain sidebar to 200px
    const setTranslates: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setTranslates(sidebar_view, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);
    const widthAnchor = objc.msgSend(sidebar_view, objc.sel("widthAnchor"));
    const constraintEq: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const widthConstraint = constraintEq(widthAnchor, objc.sel("constraintEqualToConstant:"), 200.0);
    const setActive: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setActive(widthConstraint, objc.sel("setActive:"), objc.YES);

    objc.msgSendVoid1(window, objc.sel("setContentView:"), root_split);

    // Show window
    objc.msgSendVoid(window, objc.sel("center"));
    const makeKeyAndOrderFront: *const fn (objc.id, objc.SEL, ?*anyopaque) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    makeKeyAndOrderFront(window, objc.sel("makeKeyAndOrderFront:"), null);

    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const activate: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    activate(nsapp, objc.sel("activateIgnoringOtherApps:"), objc.YES);

    objc.msgSendVoid1(window, objc.sel("makeFirstResponder:"), root_split);
}

fn shouldTerminate(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) objc.BOOL {
    return objc.YES;
}

fn appWillTerminate(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.destroyAllTerminals();
}

// -------------------------------------------------------------------------
// Action handlers
// -------------------------------------------------------------------------

fn relayoutAndFocus() void {
    const panel = main_panel_view orelse return;
    term_text_view.layoutActiveSession(panel);
    if (term_text_view.getFocusedView()) |focused| {
        const NSApp_class = objc.getClass("NSApplication") orelse return;
        const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
        const mw = objc.msgSend(nsapp, objc.sel("mainWindow"));
        objc.msgSendVoid1(mw, objc.sel("makeFirstResponder:"), focused);
    }
}

fn onSplitHorizontal(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.splitFocused(.horizontal);
    relayoutAndFocus();
}
fn onSplitVertical(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.splitFocused(.vertical);
    relayoutAndFocus();
}
fn onClosePane(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.closeFocusedPane();
    relayoutAndFocus();
}
fn onFocusNextPane(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.cycleFocus(true);
    relayoutAndFocus();
}
fn onFocusPrevPane(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.cycleFocus(false);
    relayoutAndFocus();
}
fn onIncreaseFontSize(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.adjustFontSize(1.0);
}
fn onDecreaseFontSize(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.adjustFontSize(-1.0);
}

fn onNewTerminal(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    sidebar.showNewTerminalForCurrentProject();
}
fn onSidebarNext(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    sidebar.navigateSidebar(1);
}
fn onSidebarPrev(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    sidebar.navigateSidebar(-1);
}
fn onSidebarActivate(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    sidebar.activateSelectedSidebarItem();
}
fn onAddProject(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    const application = g_app orelse return;
    sidebar.showAddProjectPanel(application);
}

fn getTagFromSender(sender: objc.id) ?usize {
    const getTag: *const fn (objc.id, objc.SEL) callconv(.c) objc.NSInteger =
        @ptrCast(&objc.c.objc_msgSend);
    const tag = getTag(sender, objc.sel("tag"));
    if (tag < 0) return null;
    return @intCast(@as(usize, @bitCast(tag)));
}

fn onOpenTerminal(_: objc.id, _: objc.SEL, sender: objc.id) callconv(.c) void {
    if (getTagFromSender(sender)) |idx| sidebar.openTerminalAtIndex(idx);
}
fn onDeleteTerminal(_: objc.id, _: objc.SEL, sender: objc.id) callconv(.c) void {
    if (getTagFromSender(sender)) |idx| sidebar.showDeleteTerminalDialog(idx);
}
fn onEditTerminal(_: objc.id, _: objc.SEL, sender: objc.id) callconv(.c) void {
    if (getTagFromSender(sender)) |idx| sidebar.showEditTerminalDialog(idx);
}
fn onAddTerminalToProject(_: objc.id, _: objc.SEL, sender: objc.id) callconv(.c) void {
    if (getTagFromSender(sender)) |idx| sidebar.showAddTerminalDialog(idx);
}

// -------------------------------------------------------------------------
// View construction
// -------------------------------------------------------------------------

var thin_split_class: ?objc.id = null;

fn registerThinSplitClass() ?objc.id {
    if (thin_split_class) |cls| return cls;
    const NSSplitView = objc.getClass("NSSplitView") orelse return null;
    const cls = objc.allocateClassPair(NSSplitView, "ThinSplitView") orelse return null;
    _ = objc.addMethod(cls, objc.sel("dividerThickness"), &thinDividerThickness, "d@:");
    objc.registerClassPair(cls);
    thin_split_class = cls;
    return cls;
}

fn thinDividerThickness(_: objc.id, _: objc.SEL) callconv(.c) objc.CGFloat {
    return 1.0;
}

fn createSplitView() objc.id {
    const cls = registerThinSplitClass() orelse objc.getClass("NSSplitView") orelse unreachable;
    const split = objc.msgSend(cls, objc.sel("new"));

    const setVertical: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setVertical(split, objc.sel("setVertical:"), objc.YES);

    const setDivider: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setDivider(split, objc.sel("setDividerStyle:"), NSSplitViewDividerStyleThin);

    return split;
}

var main_panel_class: ?objc.id = null;

fn registerMainPanelClass() ?objc.id {
    if (main_panel_class) |cls| return cls;
    const NSView = objc.getClass("NSView") orelse return null;
    const cls = objc.allocateClassPair(NSView, "MainPanelView") orelse return null;
    _ = objc.addMethod(cls, objc.sel("mouseDown:"), &mainPanelMouseDown, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseDragged:"), &mainPanelMouseDragged, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseUp:"), &mainPanelMouseUp, "v@:@");
    _ = objc.addMethod(cls, objc.sel("mouseMoved:"), &mainPanelMouseMoved, "v@:@");
    _ = objc.addMethod(cls, objc.sel("updateTrackingAreas"), &mainPanelUpdateTracking, "v@:");
    objc.registerClassPair(cls);
    main_panel_class = cls;
    return cls;
}

fn mainPanelMouseDown(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    term_text_view.handlePanelMouseDown(self, event);
}
fn mainPanelMouseDragged(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    term_text_view.handlePanelMouseDragged(self, event);
}
fn mainPanelMouseMoved(self: objc.id, _: objc.SEL, event: objc.id) callconv(.c) void {
    term_text_view.handlePanelMouseMoved(self, event);
}
fn mainPanelMouseUp(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    term_text_view.handlePanelMouseUp();
}

fn mainPanelUpdateTracking(self: objc.id, _: objc.SEL) callconv(.c) void {
    // Remove old tracking areas
    const areas = objc.msgSend(self, objc.sel("trackingAreas"));
    const count = objc.msgSendUInt(areas, objc.sel("count"));
    var i: objc.NSUInteger = 0;
    while (i < count) : (i += 1) {
        const area = objc.msgSend1(areas, objc.sel("objectAtIndex:"), i);
        objc.msgSendVoid1(self, objc.sel("removeTrackingArea:"), area);
    }

    // Add new tracking area for mouse-moved events
    const NSTrackingArea = objc.getClass("NSTrackingArea") orelse return;
    const bounds = objc.msgSendRect(self, objc.sel("bounds"));
    const opts: objc.NSUInteger = 0x02 | 0x01 | 0x40 | 0x200; // mouseMoved | entered/exited | activeApp | visibleRect
    const initTA: *const fn (objc.id, objc.SEL, objc.NSRect, objc.NSUInteger, objc.id, ?*anyopaque) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const ta = initTA(
        objc.msgSend(NSTrackingArea, objc.sel("alloc")),
        objc.sel("initWithRect:options:owner:userInfo:"),
        bounds, opts, self, null,
    );
    objc.msgSendVoid1(self, objc.sel("addTrackingArea:"), ta);
}

fn createMainPanel() objc.id {
    const cls = registerMainPanelClass() orelse unreachable;
    const main = objc.msgSend(cls, objc.sel("new"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(main, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.YES);

    // Dark background for when no terminal is open
    setBool(main, objc.sel("setWantsLayer:"), objc.YES);
    const layer = objc.msgSend(main, objc.sel("layer"));
    const NSColor = objc.getClass("NSColor") orelse unreachable;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bgColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.059, 0.078, 0.106, 1.0); // #0f141b
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), objc.msgSend(bgColor, objc.sel("CGColor")));

    // Top border line (visible below title bar when content is empty)
    const borderColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.24, 0.3, 1.0);
    objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), objc.msgSend(borderColor, objc.sel("CGColor")));
    const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBorderWidth(layer, objc.sel("setBorderWidth:"), 0.5);

    // Create header bar
    const header = createHeaderBar();
    header_view = header;
    objc.msgSendVoid1(main, objc.sel("addSubview:"), header);

    return main;
}

fn createHeaderBar() objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const header = objc.msgSend(NSView, objc.sel("new"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(header, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(header, objc.sel("layer"));
    // Match sidebar bg
    const NSColor = objc.getClass("NSColor") orelse unreachable;
    const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bgColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.09, 0.114, 0.149, 1.0);
    const cgBg = objc.msgSend(bgColor, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBackgroundColor:"), cgBg);

    // Bottom border
    const borderColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.2, 0.24, 0.3, 1.0);
    const cgBorder = objc.msgSend(borderColor, objc.sel("CGColor"));
    objc.msgSendVoid1(layer, objc.sel("setBorderColor:"), cgBorder);
    const setBorderWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBorderWidth(layer, objc.sel("setBorderWidth:"), 0.5);

    // Terminal name label (left)
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const name_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(""));
    const NSFont = objc.getClass("NSFont") orelse unreachable;
    const boldFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(name_label, objc.sel("setFont:"), boldFont(NSFont, objc.sel("boldSystemFontOfSize:"), 12.0));
    const nameColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.847, 0.937, 0.906, 1.0); // #d8efe7
    objc.msgSendVoid1(name_label, objc.sel("setTextColor:"), nameColor);
    objc.msgSendVoid1(header, objc.sel("addSubview:"), name_label);
    header_name_label = name_label;

    // Git branch label (right-aligned)
    const git_label = objc.msgSend(NSTextField, objc.sel("new"));
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(git_label, objc.sel("setFont:"), sysFont(NSFont, objc.sel("systemFontOfSize:"), 11.0));
    const gitColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.604, 0.659, 0.737, 1.0); // #9aa8bc
    objc.msgSendVoid1(git_label, objc.sel("setTextColor:"), gitColor);
    setBool(git_label, objc.sel("setBezeled:"), objc.NO);
    setBool(git_label, objc.sel("setDrawsBackground:"), objc.NO);
    setBool(git_label, objc.sel("setEditable:"), objc.NO);
    setBool(git_label, objc.sel("setSelectable:"), objc.NO);
    const setAlignment: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setAlignment(git_label, objc.sel("setAlignment:"), 2); // NSTextAlignmentRight
    objc.msgSendVoid1(header, objc.sel("addSubview:"), git_label);
    header_git_label = git_label;

    // Git changes count label (right of branch, red when non-zero)
    const changes_label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(""));
    objc.msgSendVoid1(changes_label, objc.sel("setFont:"), sysFont(NSFont, objc.sel("systemFontOfSize:"), 11.0));
    objc.msgSendVoid1(changes_label, objc.sel("setTextColor:"), gitColor);
    setAlignment(changes_label, objc.sel("setAlignment:"), 0); // NSTextAlignmentLeft
    objc.msgSendVoid1(header, objc.sel("addSubview:"), changes_label);
    header_git_changes_label = changes_label;

    // Layout with auto layout
    setBool(header, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);
    setBool(name_label, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);
    setBool(git_label, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);
    setBool(changes_label, objc.sel("setTranslatesAutoresizingMaskIntoConstraints:"), objc.NO);

    return header;
}

/// Update the header bar content for the given terminal name and project path.
pub fn updateHeader(name: []const u8, project_path: []const u8) void {
    if (header_name_label) |label| {
        objc.msgSendVoid1(label, objc.sel("setStringValue:"), objc.nsString(name));
        // Ensure name label stays white
        const NSColor = objc.getClass("NSColor") orelse return;
        const colorWith: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const nameColor = colorWith(NSColor, objc.sel("colorWithRed:green:blue:alpha:"), 0.847, 0.937, 0.906, 1.0);
        objc.msgSendVoid1(label, objc.sel("setTextColor:"), nameColor);
    }

    var branch_buf: [128]u8 = undefined;
    var count_buf: [64]u8 = undefined;
    var branch_text: []const u8 = "";
    var changes_text: []const u8 = "";
    var has_changes: bool = false;
    getGitInfo(project_path, &branch_buf, &count_buf, &branch_text, &changes_text, &has_changes) catch {};

    if (header_git_label) |label| {
        // Combine into one string
        var full_buf: [256]u8 = undefined;
        const full_text = std.fmt.bufPrint(&full_buf, "{s}  {s}", .{ branch_text, changes_text }) catch "";
        objc.msgSendVoid1(label, objc.sel("setStringValue:"), objc.nsString(full_text));

        // Gray when clean, orange-red when dirty
        const NSColor2 = objc.getClass("NSColor") orelse return;
        const colorWith2: *const fn (objc.id, objc.SEL, objc.CGFloat, objc.CGFloat, objc.CGFloat, objc.CGFloat) callconv(.c) objc.id =
            @ptrCast(&objc.c.objc_msgSend);
        const color = if (has_changes)
            colorWith2(NSColor2, objc.sel("colorWithRed:green:blue:alpha:"), 0.85, 0.55, 0.35, 1.0)
        else
            colorWith2(NSColor2, objc.sel("colorWithRed:green:blue:alpha:"), 0.604, 0.659, 0.737, 1.0);
        objc.msgSendVoid1(label, objc.sel("setTextColor:"), color);

        // Size to fit text, then pin to right edge of panel
        objc.msgSendVoid(label, objc.sel("sizeToFit"));
        const fitted = objc.msgSendRect(label, objc.sel("frame"));
        const panel = main_panel_view orelse return;
        const panel_bounds = objc.msgSendRect(panel, objc.sel("bounds"));
        const setFrame: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        const w = fitted.size.width + 4;
        setFrame(label, objc.sel("setFrame:"), objc.NSMakeRect(panel_bounds.size.width - w - 16, 12, w, 20));
    }
}

/// Clear the header (no terminal selected).
pub fn clearHeader() void {
    if (header_name_label) |label| {
        objc.msgSendVoid1(label, objc.sel("setStringValue:"), objc.nsString(""));
    }
    if (header_git_label) |label| {
        objc.msgSendVoid1(label, objc.sel("setStringValue:"), objc.nsString(""));
    }
}

fn runGitCommand(project_path: []const u8, args: []const []const u8, out_buf: []u8) ![]const u8 {
    const alloc = std.heap.page_allocator;
    var full_args = std.array_list.AlignedManaged([]const u8, null).init(alloc);
    defer full_args.deinit();
    try full_args.append("git");
    try full_args.append("-C");
    try full_args.append(project_path);
    for (args) |a| try full_args.append(a);

    var child = std.process.Child.init(full_args.items, alloc);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    try child.spawn();

    var stdout_list: std.ArrayListAligned(u8, null) = .empty;
    defer stdout_list.deinit(alloc);
    var stderr_list: std.ArrayListAligned(u8, null) = .empty;
    defer stderr_list.deinit(alloc);
    child.collectOutput(alloc, &stdout_list, &stderr_list, 64 * 1024) catch {};
    const term = try child.wait();
    if (term != .Exited or term.Exited != 0) return "";

    const trimmed = std.mem.trimRight(u8, stdout_list.items, "\n\r ");
    const len = @min(trimmed.len, out_buf.len);
    @memcpy(out_buf[0..len], trimmed[0..len]);
    return out_buf[0..len];
}

fn getGitInfo(
    project_path: []const u8,
    branch_buf: *[128]u8,
    count_buf: *[64]u8,
    branch_out: *[]const u8,
    changes_out: *[]const u8,
    has_changes: *bool,
) !void {
    const branch = try runGitCommand(project_path, &.{ "branch", "--show-current" }, branch_buf);
    if (branch.len == 0) return;

    // Count changed files
    var status_buf: [32768]u8 = undefined;
    const status_output = try runGitCommand(project_path, &.{ "status", "--porcelain" }, &status_buf);
    var changed_count: usize = 0;
    if (status_output.len > 0) {
        var lines = std.mem.splitScalar(u8, status_output, '\n');
        while (lines.next()) |line| {
            if (line.len >= 2) changed_count += 1;
        }
    }

    // Copy branch to count_buf temporarily to avoid aliasing
    var tmp_branch: [128]u8 = undefined;
    const bl = @min(branch.len, tmp_branch.len);
    @memcpy(tmp_branch[0..bl], branch[0..bl]);
    const safe_branch = tmp_branch[0..bl];

    branch_out.* = std.fmt.bufPrint(branch_buf, "{s}  •", .{safe_branch}) catch "";
    changes_out.* = std.fmt.bufPrint(count_buf, "{d} changed", .{changed_count}) catch "";
    has_changes.* = changed_count > 0;
}

// -------------------------------------------------------------------------
// Menu bar
// -------------------------------------------------------------------------

fn createMainMenu(nsapp: objc.id) void {
    const NSMenu = objc.getClass("NSMenu") orelse return;
    const NSMenuItem = objc.getClass("NSMenuItem") orelse return;

    const menubar = objc.msgSend(NSMenu, objc.sel("new"));

    // App menu
    const app_item = objc.msgSend(NSMenuItem, objc.sel("new"));
    const app_menu = objc.msgSend1(
        objc.msgSend(NSMenu, objc.sel("alloc")),
        objc.sel("initWithTitle:"),
        objc.nsString("my-term"),
    );
    addMenuItemNoTarget(app_menu, NSMenuItem, "Quit my-term", "q", "terminate:");
    objc.msgSendVoid1(app_item, objc.sel("setSubmenu:"), app_menu);
    objc.msgSendVoid1(menubar, objc.sel("addItem:"), app_item);

    // Shell menu (exposes keyboard shortcuts)
    const shell_item = objc.msgSend(NSMenuItem, objc.sel("new"));
    const shell_menu = objc.msgSend1(
        objc.msgSend(NSMenu, objc.sel("alloc")),
        objc.sel("initWithTitle:"),
        objc.nsString("Shell"),
    );
    addMenuItem(shell_menu, NSMenuItem, "Split Right", "d", "splitHorizontal:");
    addMenuItem(shell_menu, NSMenuItem, "Split Down", "D", "splitVertical:");
    addMenuItem(shell_menu, NSMenuItem, "Close Pane", "w", "closePane:");
    addMenuSeparator(shell_menu);
    addMenuItem(shell_menu, NSMenuItem, "Next Pane", "]", "focusNextPane:");
    addMenuItem(shell_menu, NSMenuItem, "Previous Pane", "[", "focusPrevPane:");
    addMenuItem(shell_menu, NSMenuItem, "Increase Font Size", "=", "increaseFontSize:");
    addMenuItem(shell_menu, NSMenuItem, "Decrease Font Size", "-", "decreaseFontSize:");
    addMenuSeparator(shell_menu);
    addMenuItem(shell_menu, NSMenuItem, "Next Sidebar Item", "}", "sidebarNext:");
    addMenuItem(shell_menu, NSMenuItem, "Previous Sidebar Item", "{", "sidebarPrev:");
    addMenuItem(shell_menu, NSMenuItem, "Activate Sidebar Item", "\r", "sidebarActivate:");
    addMenuSeparator(shell_menu);
    addMenuItem(shell_menu, NSMenuItem, "New Terminal", "t", "newTerminal:");
    addMenuItem(shell_menu, NSMenuItem, "Add Project…", "o", "addProject:");
    objc.msgSendVoid1(shell_item, objc.sel("setSubmenu:"), shell_menu);
    objc.msgSendVoid1(menubar, objc.sel("addItem:"), shell_item);

    objc.msgSendVoid1(nsapp, objc.sel("setMainMenu:"), menubar);
}

fn addMenuItem(menu: objc.id, NSMenuItem: objc.id, title: []const u8, key: []const u8, action: [*:0]const u8) void {
    addMenuItemWithTarget(menu, NSMenuItem, title, key, action, true);
}

fn addMenuItemNoTarget(menu: objc.id, NSMenuItem: objc.id, title: []const u8, key: []const u8, action: [*:0]const u8) void {
    addMenuItemWithTarget(menu, NSMenuItem, title, key, action, false);
}

fn addMenuItemWithTarget(menu: objc.id, NSMenuItem: objc.id, title: []const u8, key: []const u8, action: [*:0]const u8, set_target: bool) void {
    const initItem: *const fn (objc.id, objc.SEL, objc.id, objc.SEL, objc.id) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const item = initItem(
        objc.msgSend(NSMenuItem, objc.sel("alloc")),
        objc.sel("initWithTitle:action:keyEquivalent:"),
        objc.nsString(title),
        objc.sel(action),
        objc.nsString(key),
    );
    if (set_target) {
        if (app_delegate) |delegate| {
            objc.msgSendVoid1(item, objc.sel("setTarget:"), delegate);
        }
    }
    objc.msgSendVoid1(menu, objc.sel("addItem:"), item);
}

fn addMenuSeparator(menu: objc.id) void {
    const NSMenuItem = objc.getClass("NSMenuItem") orelse return;
    objc.msgSendVoid1(menu, objc.sel("addItem:"), objc.msgSend(NSMenuItem, objc.sel("separatorItem")));
}
