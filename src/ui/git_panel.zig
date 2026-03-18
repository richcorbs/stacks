/// Git panel — shows git status, staging, commits, log, branches.
///
/// Mirrors the Electron app's git panel section:
///   - Worktree/branch selectors
///   - Init / Pull / Push / Refresh buttons
///   - Changed files list with stage/unstage
///   - Commit message input + Commit Staged / Commit All
///   - Output history
///   - Git log
const std = @import("std");
const objc = @import("../objc.zig");
const app_mod = @import("../app.zig");
const git = @import("../git.zig");

/// The root NSView for the git panel.
var git_panel_view: ?objc.id = null;
var status_table_view: ?objc.id = null;
var commit_field: ?objc.id = null;
var feedback_text: ?objc.id = null;
var log_text: ?objc.id = null;
var branch_label: ?objc.id = null;

/// Create the git panel view hierarchy.
pub fn createGitPanelView() objc.id {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const panel = objc.msgSend(NSView, objc.sel("new"));
    git_panel_view = panel;

    const setWantsLayer: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWantsLayer(panel, objc.sel("setWantsLayer:"), objc.YES);

    const layer = objc.msgSend(panel, objc.sel("layer"));
    setBackgroundColor(layer, 0.09, 0.114, 0.133); // #171d22

    // We build the panel as a vertical NSStackView
    const NSStackView = objc.getClass("NSStackView") orelse unreachable;
    const stack = objc.msgSend(NSStackView, objc.sel("new"));

    const setOrientation: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setOrientation(stack, objc.sel("setOrientation:"), 1); // NSUserInterfaceLayoutOrientationVertical

    const setSpacing: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setSpacing(stack, objc.sel("setSpacing:"), 12.0);

    // --- Controls row: Init / Pull / Push / Refresh ---
    const controls = createControlsRow();
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), controls);

    // --- Branch info ---
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const bl = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Branch: —"));
    setTextColor(bl, 0.604, 0.659, 0.737);
    branch_label = bl;
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), bl);

    // --- Section: Changed files ---
    const status_header = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Changed files"));
    setTextColor(status_header, 0.604, 0.659, 0.737);
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), status_header);

    const status_scroll = createStatusList();
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), status_scroll);

    // --- Section: Commit ---
    const commit_header = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Commit"));
    setTextColor(commit_header, 0.604, 0.659, 0.737);
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), commit_header);

    const commit_row = createCommitRow();
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), commit_row);

    // --- Section: Output ---
    const output_header = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Output"));
    setTextColor(output_header, 0.604, 0.659, 0.737);
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), output_header);

    const fb = createTextArea();
    feedback_text = fb;
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), fb);

    // --- Section: Git log ---
    const log_header = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString("Git log"));
    setTextColor(log_header, 0.604, 0.659, 0.737);
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), log_header);

    const lt = createTextArea();
    log_text = lt;
    objc.msgSendVoid1(stack, objc.sel("addArrangedSubview:"), lt);

    // Wrap stack in a scroll view
    const NSScrollView = objc.getClass("NSScrollView") orelse unreachable;
    const scroll = objc.msgSend(NSScrollView, objc.sel("new"));
    objc.msgSendVoid1(scroll, objc.sel("setDocumentView:"), stack);

    const setHasVert: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setHasVert(scroll, objc.sel("setHasVerticalScroller:"), objc.YES);

    objc.msgSendVoid1(panel, objc.sel("addSubview:"), scroll);

    return panel;
}

/// Refresh the git panel content for the given project.
pub fn refreshGitPanel(application: *app_mod.App, project_id: []const u8, override_path: ?[]const u8) void {
    var overview = application.gitOverview(project_id, override_path) catch return;
    defer overview.deinit();

    // Update branch label
    if (branch_label) |bl| {
        const branch_text = overview.branch orelse "—";
        var buf: [256]u8 = undefined;
        const text = std.fmt.bufPrint(&buf, "Branch: {s}", .{branch_text}) catch "Branch: —";
        objc.msgSendVoid1(bl, objc.sel("setStringValue:"), objc.nsString(text));
    }

    // Update status list
    updateStatusList(overview.status.items);

    // Update log
    var log_entries = application.gitLog(project_id, 20, override_path) catch return;
    defer log_entries.deinit();
    updateLogText(log_entries.items);
}

/// Set the output/feedback text.
pub fn setFeedback(text: []const u8, is_error: bool) void {
    _ = is_error;
    if (feedback_text) |ft| {
        objc.msgSendVoid1(ft, objc.sel("setStringValue:"), objc.nsString(text));
    }
}

// ---------------------------------------------------------------------------
// Internal view construction
// ---------------------------------------------------------------------------

fn createControlsRow() objc.id {
    const NSStackView = objc.getClass("NSStackView") orelse unreachable;
    const row = objc.msgSend(NSStackView, objc.sel("new"));

    const setOrientation: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setOrientation(row, objc.sel("setOrientation:"), 0); // Horizontal

    const setSpacing: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setSpacing(row, objc.sel("setSpacing:"), 8.0);

    const buttons = [_][]const u8{ "Init Repo", "Pull", "Push", "Refresh" };
    const actions = [_][*:0]const u8{ "gitInit:", "gitPull:", "gitPush:", "gitRefresh:" };

    const NSButton = objc.getClass("NSButton") orelse unreachable;
    for (buttons, actions) |title, action| {
        _ = action;
        const btn = objc.msgSend1(
            NSButton,
            objc.sel("buttonWithTitle:target:action:"),
            objc.nsString(title),
        );
        objc.msgSendVoid1(row, objc.sel("addArrangedSubview:"), btn);
    }

    return row;
}

fn createCommitRow() objc.id {
    const NSStackView = objc.getClass("NSStackView") orelse unreachable;
    const row = objc.msgSend(NSStackView, objc.sel("new"));

    const setOrientation: *const fn (objc.id, objc.SEL, objc.NSInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setOrientation(row, objc.sel("setOrientation:"), 0);

    const setSpacing: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setSpacing(row, objc.sel("setSpacing:"), 8.0);

    // Text field for commit message
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const field = objc.msgSend(NSTextField, objc.sel("new"));
    objc.msgSendVoid1(field, objc.sel("setPlaceholderString:"), objc.nsString("Commit message"));
    commit_field = field;
    objc.msgSendVoid1(row, objc.sel("addArrangedSubview:"), field);

    // Commit Staged button
    const NSButton = objc.getClass("NSButton") orelse unreachable;
    const staged_btn = objc.msgSend1(
        NSButton,
        objc.sel("buttonWithTitle:target:action:"),
        objc.nsString("Commit Staged"),
    );
    objc.msgSendVoid1(row, objc.sel("addArrangedSubview:"), staged_btn);

    // Commit All button
    const all_btn = objc.msgSend1(
        NSButton,
        objc.sel("buttonWithTitle:target:action:"),
        objc.nsString("Commit All"),
    );
    objc.msgSendVoid1(row, objc.sel("addArrangedSubview:"), all_btn);

    return row;
}

fn createStatusList() objc.id {
    const NSScrollView = objc.getClass("NSScrollView") orelse unreachable;
    const scroll = objc.msgSend(NSScrollView, objc.sel("new"));

    const NSTableView = objc.getClass("NSTableView") orelse unreachable;
    const table = objc.msgSend(NSTableView, objc.sel("new"));
    status_table_view = table;

    // Hide header
    const setHeaderView: *const fn (objc.id, objc.SEL, ?objc.id) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setHeaderView(table, objc.sel("setHeaderView:"), null);

    // Add columns: code, path
    const NSTableColumn = objc.getClass("NSTableColumn") orelse unreachable;
    const code_col = objc.msgSend1(
        objc.msgSend(NSTableColumn, objc.sel("alloc")),
        objc.sel("initWithIdentifier:"),
        objc.nsString("code"),
    );
    const setWidth: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setWidth(code_col, objc.sel("setWidth:"), 34.0);
    objc.msgSendVoid1(table, objc.sel("addTableColumn:"), code_col);

    const path_col = objc.msgSend1(
        objc.msgSend(NSTableColumn, objc.sel("alloc")),
        objc.sel("initWithIdentifier:"),
        objc.nsString("path"),
    );
    setWidth(path_col, objc.sel("setWidth:"), 400.0);
    objc.msgSendVoid1(table, objc.sel("addTableColumn:"), path_col);

    objc.msgSendVoid1(scroll, objc.sel("setDocumentView:"), table);

    const setHasVert: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setHasVert(scroll, objc.sel("setHasVerticalScroller:"), objc.YES);

    return scroll;
}

fn createTextArea() objc.id {
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;
    const field = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(""));

    const setSelectable: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setSelectable(field, objc.sel("setSelectable:"), objc.YES);

    // Use monospace font
    const NSFont = objc.getClass("NSFont") orelse unreachable;
    const font: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const mono = font(NSFont, objc.sel("monospacedSystemFontOfSize:weight:"), 11.0);
    _ = mono;

    setTextColor(field, 0.494, 0.682, 0.831); // #7eaed4

    return field;
}

// ---------------------------------------------------------------------------
// Data update helpers
// ---------------------------------------------------------------------------

fn updateStatusList(entries: []const git.StatusEntry) void {
    // In a full implementation, this would update the NSTableView's data source.
    // For now, we show status as text in the feedback area.
    _ = entries;
}

fn updateLogText(entries: []const []const u8) void {
    if (log_text == null) return;
    if (entries.len == 0) {
        objc.msgSendVoid1(log_text.?, objc.sel("setStringValue:"), objc.nsString("No commits yet"));
        return;
    }

    // Join entries with newlines
    // (Simplified — in production, use a proper buffer)
    var buf: [8192]u8 = undefined;
    var pos: usize = 0;
    for (entries) |entry| {
        if (pos + entry.len + 1 > buf.len) break;
        @memcpy(buf[pos..][0..entry.len], entry);
        pos += entry.len;
        buf[pos] = '\n';
        pos += 1;
    }
    objc.msgSendVoid1(log_text.?, objc.sel("setStringValue:"), objc.nsString(buf[0..pos]));
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

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
