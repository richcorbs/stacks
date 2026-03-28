/// Dialogs — modal dialog UI for project and terminal management.
///
/// Extracted from sidebar.zig to reduce file size. These functions present
/// NSAlert/NSOpenPanel dialogs and update the project store accordingly.
const std = @import("std");
const objc = @import("../objc.zig");
const app_mod = @import("../app.zig");
const term_text_view = @import("term_text_view.zig");
const sidebar = @import("sidebar.zig");
const window_ui = @import("window.zig");

// ---------------------------------------------------------------------------
// Add Project
// ---------------------------------------------------------------------------

pub fn showAddProjectPanel(application: *app_mod.App) void {
    const alert = createAlert("Add Project", "Enter a project name and select a directory.") orelse return;
    addButton(alert, "Add");
    addButton(alert, "Cancel");

    const fields = addNameDirFields(alert, "", "");

    if (runModalCentered(alert) != 1000) return;

    var name = readTextField(fields.name_field);
    var dir = readTextField(fields.dir_field);

    // If no directory specified, open a folder picker
    if (dir.len == 0) {
        const picked = showFolderPicker() orelse return;
        dir = picked;
    }

    if (dir.len == 0) return;

    // If no name specified, derive from directory basename
    if (name.len == 0) {
        name = std.fs.path.basename(dir);
    }

    const project = application.addProject(dir) catch return;

    // Update name if user provided one different from basename
    application.store.updateProject(project.id, name, "") catch {};

    sidebar.rebuildSidebar(application);
}

fn showFolderPicker() ?[]const u8 {
    const NSOpenPanel = objc.getClass("NSOpenPanel") orelse return null;
    const panel = objc.msgSend(NSOpenPanel, objc.sel("openPanel"));

    objc.msgSendVoid1(panel, objc.sel("setTitle:"), objc.nsString("Select Project Folder"));

    const setBool: *const fn (objc.id, objc.SEL, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setBool(panel, objc.sel("setCanChooseFiles:"), objc.NO);
    setBool(panel, objc.sel("setCanChooseDirectories:"), objc.YES);
    setBool(panel, objc.sel("setCanCreateDirectories:"), objc.YES);

    const result = objc.msgSendUInt(panel, objc.sel("runModal"));
    const NSModalResponseOK: objc.NSUInteger = 1;
    if (result != NSModalResponseOK) return null;

    const urls = objc.msgSend(panel, objc.sel("URLs"));
    const count = objc.msgSendUInt(urls, objc.sel("count"));
    if (count == 0) return null;

    const url = objc.msgSend1(urls, objc.sel("objectAtIndex:"), @as(objc.NSUInteger, 0));
    const path_nsstring = objc.msgSend(url, objc.sel("path"));
    const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(path_nsstring, objc.sel("UTF8String")));
    return std.mem.span(utf8);
}

// ---------------------------------------------------------------------------
// Delete Project
// ---------------------------------------------------------------------------

pub fn showDeleteProjectDialog(project_index: usize) void {
    const application = sidebar.g_sidebar_app orelse return;
    const projs = application.projects();
    if (project_index >= projs.len) return;
    const proj = projs[project_index];

    var msg_buf: [256]u8 = undefined;
    const alert = createAlert(
        std.fmt.bufPrint(&msg_buf, "Delete project \"{s}\"?", .{proj.name}) catch "Delete project?",
        "This will remove the project from the sidebar and close all its terminals. The files on disk will not be affected.",
    ) orelse return;
    setAlertStyleCritical(alert);
    addButton(alert, "Delete");
    addButton(alert, "Cancel");

    if (runModalCentered(alert) != 1000) return;

    // Find a terminal in another project to select after deletion
    var next_terminal_id: ?[]const u8 = null;
    if (sidebar.getSelectedTerminalIndex() != null) {
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

    for (proj.terminals.items) |t| {
        term_text_view.destroySession(t.id);
    }

    _ = application.store.projects.orderedRemove(project_index);
    application.store.save() catch {};

    sidebar.clearSelection();
    sidebar.rebuildSidebar(application);

    if (next_terminal_id) |neighbor_id| {
        if (sidebar.findTermRowByTerminalId(neighbor_id)) |idx| {
            sidebar.openTerminalAtIndex(idx);
            return;
        }
    }
    window_ui.clearHeader();
}

// ---------------------------------------------------------------------------
// Edit Project
// ---------------------------------------------------------------------------

pub fn showEditProjectDialog(project_index: usize) void {
    const application = sidebar.g_sidebar_app orelse return;
    const projs = application.projects();
    if (project_index >= projs.len) return;
    const proj = projs[project_index];

    const alert = createAlert("Edit Project", "Edit the project name and directory.") orelse return;
    addButton(alert, "Save");
    addButton(alert, "Cancel");

    const fields = addNameDirFields(alert, proj.name, proj.path);

    if (runModalCentered(alert) != 1000) return;

    const name = readTextField(fields.name_field);
    const dir = readTextField(fields.dir_field);
    if (name.len == 0) return;

    application.store.updateProject(proj.id, name, dir) catch return;
    sidebar.rebuildSidebar(application);
}

// ---------------------------------------------------------------------------
// Delete Terminal
// ---------------------------------------------------------------------------

pub fn showDeleteTerminalDialog(info_index: usize) void {
    const application = sidebar.g_sidebar_app orelse return;
    const info = sidebar.getTermRowInfo(info_index) orelse return;

    const proj = application.store.findById(info.project_id) orelse return;
    var term_name: []const u8 = "this terminal";
    for (proj.terminals.items) |t| {
        if (std.mem.eql(u8, t.id, info.terminal_id)) {
            term_name = t.name;
            break;
        }
    }

    var msg_buf: [256]u8 = undefined;
    const alert = createAlert(
        "Delete Terminal",
        std.fmt.bufPrint(&msg_buf, "Are you sure you want to delete \"{s}\"?", .{term_name}) catch "Are you sure?",
    ) orelse return;
    setAlertStyleCritical(alert);
    addButton(alert, "Delete");
    addButton(alert, "Cancel");

    if (runModalCentered(alert) != 1000) return;

    // Determine neighbor to select
    var next_terminal_id: ?[]const u8 = null;
    const is_active = if (sidebar.getSelectedTerminalIndex()) |sel| sel == info_index else false;
    if (is_active) {
        next_terminal_id = sidebar.findNeighborTerminal(info_index);
    }

    _ = application.store.deleteTerminal(info.project_id, info.terminal_id) catch {};
    term_text_view.destroySession(info.terminal_id);
    sidebar.clearSelection();
    sidebar.rebuildSidebar(application);

    if (is_active) {
        if (next_terminal_id) |neighbor_id| {
            if (sidebar.findTermRowByTerminalId(neighbor_id)) |idx| {
                sidebar.openTerminalAtIndex(idx);
                return;
            }
        }
        window_ui.clearHeader();
    } else {
        // Re-select the previously active terminal
        if (term_text_view.getActiveTerminalId()) |active_tid| {
            if (sidebar.findTermRowByTerminalId(active_tid)) |idx| {
                sidebar.setSelectedTerminalIndex(idx);
            }
        }
        sidebar.rebuildSidebar(application);
    }
}

// ---------------------------------------------------------------------------
// Edit Terminal
// ---------------------------------------------------------------------------

pub fn showEditTerminalDialog(info_index: usize) void {
    const application = sidebar.g_sidebar_app orelse return;
    const info = sidebar.getTermRowInfo(info_index) orelse return;

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

    const alert = createAlert("Edit Terminal", "Edit the name and startup command.") orelse return;
    addButton(alert, "Save");
    addButton(alert, "Cancel");

    const fields = addNameCommandFields(alert, current_name, current_command);

    if (runModalCentered(alert) != 1000) return;

    const name = readTextField(fields.name_field);
    const cmd = readTextField(fields.cmd_field);
    if (name.len == 0) return;

    _ = application.store.renameTerminal(info.project_id, info.terminal_id, name) catch {};

    if (application.store.findById(info.project_id)) |p| {
        for (p.terminals.items) |*t| {
            if (std.mem.eql(u8, t.id, info.terminal_id)) {
                t.command = if (cmd.len > 0) application.store.allocator.dupe(u8, cmd) catch null else null;
                break;
            }
        }
        application.store.save() catch {};
    }

    sidebar.rebuildSidebar(application);
}

// ---------------------------------------------------------------------------
// Add Terminal
// ---------------------------------------------------------------------------

pub fn showAddTerminalDialog(project_index: usize) void {
    showAddTerminalDialogWithDefault(project_index, "");
}

pub fn showNewTerminalForCurrentProject() void {
    const application = sidebar.g_sidebar_app orelse return;
    var current_project_idx: ?usize = null;
    if (sidebar.getSelectedTerminalIndex()) |sel_idx| {
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

    const proj_idx = current_project_idx orelse blk: {
        if (application.projects().len > 0) break :blk @as(usize, 0);
        return;
    };

    showAddTerminalDialogWithDefault(proj_idx, "Terminal");
}

fn showAddTerminalDialogWithDefault(project_index: usize, default_name: []const u8) void {
    const application = sidebar.g_sidebar_app orelse return;
    const projs = application.projects();
    if (project_index >= projs.len) return;
    const proj = projs[project_index];

    const alert = createAlert("Add Terminal", "Enter a name and optional startup command.") orelse return;
    addButton(alert, "Add");
    addButton(alert, "Cancel");

    const fields = addNameCommandFields(alert, default_name, "");

    if (runModalCentered(alert) != 1000) return;

    const name = readTextField(fields.name_field);
    const cmd = readTextField(fields.cmd_field);
    if (name.len == 0) return;

    const command: ?[]const u8 = if (cmd.len > 0) cmd else null;
    const new_terminal = application.store.addTerminal(proj.id, name, command) catch return;
    const new_id = new_terminal.id;
    sidebar.rebuildSidebar(application);

    if (sidebar.findTermRowByTerminalId(new_id)) |idx| {
        sidebar.openTerminalAtIndex(idx);
    }
}

// ---------------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------------

fn createAlert(message: []const u8, informative: []const u8) ?objc.id {
    const NSAlert = objc.getClass("NSAlert") orelse return null;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));
    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString(message));
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"), objc.nsString(informative));
    return alert;
}

fn setAlertStyleCritical(alert: objc.id) void {
    const setStyle: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setStyle(alert, objc.sel("setAlertStyle:"), 2);
}

fn addButton(alert: objc.id, title: []const u8) void {
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString(title));
}

fn runModalCentered(alert: objc.id) objc.NSUInteger {
    const NSApp_class = objc.getClass("NSApplication") orelse return 0;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));
    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid(alert_window, objc.sel("layoutIfNeeded"));

    const main_frame = objc.msgSendRect(main_window, objc.sel("frame"));
    const alert_frame = objc.msgSendRect(alert_window, objc.sel("frame"));
    const setFrameOrigin: *const fn (objc.id, objc.SEL, objc.NSPoint) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameOrigin(alert_window, objc.sel("setFrameOrigin:"), .{
        .x = main_frame.origin.x + (main_frame.size.width - alert_frame.size.width) / 2.0,
        .y = main_frame.origin.y + (main_frame.size.height - alert_frame.size.height) / 2.0,
    });

    return objc.msgSendUInt(alert, objc.sel("runModal"));
}

const NameCommandFields = struct { name_field: objc.id, cmd_field: objc.id };

fn addNameCommandFields(alert: objc.id, default_name: []const u8, default_command: []const u8) NameCommandFields {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;

    // Layout: label(16) + gap(4) + field(24) + gap(20) + label(16) + gap(4) + field(24) = 108
    const accessory = objc.msgSend(NSView, objc.sel("new"));
    const setFrameFn: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameFn(accessory, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 320, 108));

    const name_label = createDimLabel(NSTextField, "Name");
    setFrameFn(name_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 88, 320, 16));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_label);

    const name_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(name_field, objc.sel("setFrame:"), objc.NSMakeRect(0, 60, 320, 24));
    if (default_name.len > 0) {
        objc.msgSendVoid1(name_field, objc.sel("setStringValue:"), objc.nsString(default_name));
    } else {
        objc.msgSendVoid1(name_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. Dev Server"));
    }
    setFieldFont(name_field);
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_field);

    const cmd_label = createDimLabel(NSTextField, "Command");
    setFrameFn(cmd_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 28, 320, 16));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_label);

    const cmd_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(cmd_field, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 320, 24));
    if (default_command.len > 0) {
        objc.msgSendVoid1(cmd_field, objc.sel("setStringValue:"), objc.nsString(default_command));
    }
    objc.msgSendVoid1(cmd_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. npm run dev"));
    setFieldFont(cmd_field);
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), cmd_field);

    objc.msgSendVoid1(alert, objc.sel("setAccessoryView:"), accessory);

    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid1(alert_window, objc.sel("setInitialFirstResponder:"), name_field);

    return .{ .name_field = name_field, .cmd_field = cmd_field };
}

const NameDirFields = struct { name_field: objc.id, dir_field: objc.id };

fn addNameDirFields(alert: objc.id, default_name: []const u8, default_dir: []const u8) NameDirFields {
    const NSView = objc.getClass("NSView") orelse unreachable;
    const NSTextField = objc.getClass("NSTextField") orelse unreachable;

    // Layout: label(16) + gap(4) + field(24) + gap(20) + label(16) + gap(4) + field(24) = 108
    const accessory = objc.msgSend(NSView, objc.sel("new"));
    const setFrameFn: *const fn (objc.id, objc.SEL, objc.NSRect) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    setFrameFn(accessory, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 320, 108));

    const name_label = createDimLabel(NSTextField, "Name");
    setFrameFn(name_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 88, 320, 16));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_label);

    const name_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(name_field, objc.sel("setFrame:"), objc.NSMakeRect(0, 60, 320, 24));
    if (default_name.len > 0) {
        objc.msgSendVoid1(name_field, objc.sel("setStringValue:"), objc.nsString(default_name));
    } else {
        objc.msgSendVoid1(name_field, objc.sel("setPlaceholderString:"), objc.nsString("e.g. My Project"));
    }
    setFieldFont(name_field);
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), name_field);

    const dir_label = createDimLabel(NSTextField, "Directory");
    setFrameFn(dir_label, objc.sel("setFrame:"), objc.NSMakeRect(0, 28, 320, 16));
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), dir_label);

    // Directory field with Browse button
    const dir_field = objc.msgSend(NSTextField, objc.sel("new"));
    setFrameFn(dir_field, objc.sel("setFrame:"), objc.NSMakeRect(0, 0, 280, 24));
    if (default_dir.len > 0) {
        objc.msgSendVoid1(dir_field, objc.sel("setStringValue:"), objc.nsString(default_dir));
    }
    objc.msgSendVoid1(dir_field, objc.sel("setPlaceholderString:"), objc.nsString("/path/to/project"));
    setFieldFont(dir_field);
    objc.msgSendVoid1(accessory, objc.sel("addSubview:"), dir_field);

    // Browse button — opens folder picker and fills the dir field
    const browse_cls = registerBrowseButtonClass();
    if (browse_cls) |cls| {
        const browse_btn = objc.msgSend(cls, objc.sel("new"));
        objc.msgSendVoid1(browse_btn, objc.sel("setTitle:"), objc.nsString("..."));
        const setBezel: *const fn (objc.id, objc.SEL, objc.NSUInteger) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setBezel(browse_btn, objc.sel("setBezelStyle:"), 1);
        setFrameFn(browse_btn, objc.sel("setFrame:"), objc.NSMakeRect(284, -1, 36, 25));
        // Store dir_field reference in the button's tag (we'll use a global for simplicity)
        g_browse_target_field = dir_field;
        objc.msgSendVoid1(browse_btn, objc.sel("setTarget:"), browse_btn);
        objc.msgSendVoid1(browse_btn, objc.sel("setAction:"), objc.sel("browseClicked:"));
        objc.msgSendVoid1(accessory, objc.sel("addSubview:"), browse_btn);
    }

    objc.msgSendVoid1(alert, objc.sel("setAccessoryView:"), accessory);

    const alert_window = objc.msgSend(alert, objc.sel("window"));
    objc.msgSendVoid1(alert_window, objc.sel("setInitialFirstResponder:"), name_field);

    return .{ .name_field = name_field, .dir_field = dir_field };
}

// ---------------------------------------------------------------------------
// Browse button for directory picker
// ---------------------------------------------------------------------------

var g_browse_target_field: ?objc.id = null;
var browse_button_class: ?objc.id = null;

fn registerBrowseButtonClass() ?objc.id {
    if (browse_button_class) |cls| return cls;
    const NSButton = objc.getClass("NSButton") orelse return null;
    const cls = objc.allocateClassPair(NSButton, "BrowseDirButton") orelse return null;
    _ = objc.addMethod(cls, objc.sel("browseClicked:"), &onBrowseClicked, "v@:@");
    objc.registerClassPair(cls);
    browse_button_class = cls;
    return cls;
}

fn onBrowseClicked(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    const dir_field = g_browse_target_field orelse return;
    const picked = showFolderPicker() orelse return;
    objc.msgSendVoid1(dir_field, objc.sel("setStringValue:"), objc.nsString(picked));
}

fn setFieldFont(field: objc.id) void {
    const NSFont = objc.getClass("NSFont") orelse return;
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(field, objc.sel("setFont:"), sysFont(NSFont, objc.sel("systemFontOfSize:"), 14.0));
}

fn createDimLabel(NSTextField: objc.id, text: []const u8) objc.id {
    const label = objc.msgSend1(NSTextField, objc.sel("labelWithString:"), objc.nsString(text));
    const NSFont = objc.getClass("NSFont") orelse return label;
    const sysFont: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    objc.msgSendVoid1(label, objc.sel("setFont:"), sysFont(NSFont, objc.sel("systemFontOfSize:"), 11.0));
    const NSColor = objc.getClass("NSColor") orelse return label;
    objc.msgSendVoid1(label, objc.sel("setTextColor:"), objc.msgSend(NSColor, objc.sel("secondaryLabelColor")));
    return label;
}

fn readTextField(field: objc.id) []const u8 {
    const nsstr = objc.msgSend(field, objc.sel("stringValue"));
    const utf8: [*:0]const u8 = @ptrCast(objc.msgSend(nsstr, objc.sel("UTF8String")));
    return std.mem.span(utf8);
}
