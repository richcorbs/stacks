/// Auto-updater — checks GitHub releases for newer versions and offers to update.
const std = @import("std");
const objc = @import("objc.zig");
const version = @import("version.zig");

const REPO = "richcorbs/stacks";
const GITHUB_API = "https://api.github.com/repos/" ++ REPO ++ "/releases/latest";
const RELEASE_NOTES_BASE = "https://github.com/" ++ REPO ++ "/releases/tag/";

const allocator = std.heap.c_allocator;

var checking: bool = false;

// Shared state for passing info from background thread to main thread
var pending_tag: [64]u8 = undefined;
var pending_tag_len: usize = 0;
var pending_url: [512]u8 = undefined;
var pending_url_len: usize = 0;

/// Start the update checker — runs once after a short delay, then every hour.
pub fn start() void {
    const cls = registerHelperClass() orelse return;
    const helper = objc.msgSend(cls, objc.sel("new"));
    const NSTimer = objc.getClass("NSTimer") orelse return;
    const schedFn: *const fn (objc.id, objc.SEL, f64, objc.id, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) objc.id =
        @ptrCast(&objc.c.objc_msgSend);

    // One-shot after 5 seconds
    _ = schedFn(NSTimer, objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        5.0, helper, objc.sel("checkForUpdate:"), null, objc.NO);

    // Repeating hourly
    _ = schedFn(NSTimer, objc.sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        3600.0, helper, objc.sel("checkForUpdate:"), null, objc.YES);
}

var helper_class: ?objc.id = null;

fn registerHelperClass() ?objc.id {
    if (helper_class) |cls| return cls;
    const NSObject = objc.getClass("NSObject") orelse return null;
    const cls = objc.allocateClassPair(NSObject, "StacksUpdateHelper") orelse return null;
    _ = objc.addMethod(cls, objc.sel("checkForUpdate:"), &onCheckTimer, "v@:@");
    _ = objc.addMethod(cls, objc.sel("showUpdateAlert:"), &onShowAlert, "v@:@");
    objc.registerClassPair(cls);
    helper_class = cls;
    return cls;
}

fn onCheckTimer(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    if (checking) return;
    checking = true;
    _ = std.Thread.spawn(.{}, backgroundCheck, .{}) catch {
        checking = false;
    };
}

fn onShowAlert(_: objc.id, _: objc.SEL, _: objc.id) callconv(.c) void {
    showUpdateAlert();
}

fn backgroundCheck() void {
    defer checking = false;

    const info = fetchLatestVersion() catch return;
    defer {
        if (info.tag.len > 0) allocator.free(info.tag);
        if (info.url.len > 0) allocator.free(info.url);
    }

    if (info.tag.len == 0 or info.url.len == 0) return;
    if (!isNewer(info.tag, version.string)) return;

    // Copy to shared buffers
    const tlen = @min(info.tag.len, pending_tag.len);
    @memcpy(pending_tag[0..tlen], info.tag[0..tlen]);
    pending_tag_len = tlen;
    const ulen = @min(info.url.len, pending_url.len);
    @memcpy(pending_url[0..ulen], info.url[0..ulen]);
    pending_url_len = ulen;

    // Dispatch to main thread
    const cls = helper_class orelse return;
    const helper = objc.msgSend(cls, objc.sel("new"));
    const performOnMain: *const fn (objc.id, objc.SEL, objc.SEL, ?*anyopaque, objc.BOOL) callconv(.c) void =
        @ptrCast(&objc.c.objc_msgSend);
    performOnMain(helper, objc.sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
        objc.sel("showUpdateAlert:"), null, objc.NO);
}

const VersionInfo = struct { tag: []const u8, url: []const u8 };

fn fetchLatestVersion() !VersionInfo {
    var result = std.process.Child.init(
        &[_][]const u8{ "curl", "-sf", "-H", "Accept: application/vnd.github.v3+json", GITHUB_API },
        allocator,
    );
    result.stdout_behavior = .Pipe;
    result.stderr_behavior = .Pipe;
    try result.spawn();
    var stdout_list: std.ArrayListAligned(u8, null) = .empty;
    defer stdout_list.deinit(allocator);
    var stderr_list: std.ArrayListAligned(u8, null) = .empty;
    defer stderr_list.deinit(allocator);
    result.collectOutput(allocator, &stdout_list, &stderr_list, 64 * 1024) catch return error.FetchFailed;
    const term = try result.wait();
    if (term != .Exited or term.Exited != 0) return error.FetchFailed;
    const stdout = stdout_list.items;

    var tag: []const u8 = "";
    var url: []const u8 = "";

    // Parse "tag_name": "..."
    if (std.mem.indexOf(u8, stdout, "\"tag_name\"")) |idx| {
        const rest = stdout[idx + 11..];
        if (std.mem.indexOf(u8, rest, "\"")) |q1| {
            const after = rest[q1 + 1..];
            if (std.mem.indexOf(u8, after, "\"")) |q2| {
                tag = try allocator.dupe(u8, after[0..q2]);
            }
        }
    }

    // Find browser_download_url for .zip
    if (std.mem.indexOf(u8, stdout, "\"browser_download_url\"")) |idx| {
        const rest = stdout[idx + 23..];
        if (std.mem.indexOf(u8, rest, "\"")) |q1| {
            const after = rest[q1 + 1..];
            if (std.mem.indexOf(u8, after, "\"")) |q2| {
                url = try allocator.dupe(u8, after[0..q2]);
            }
        }
    }

    return .{ .tag = tag, .url = url };
}

fn isNewer(remote: []const u8, local: []const u8) bool {
    const r = parseVersion(remote);
    const l = parseVersion(local);
    if (r.major != l.major) return r.major > l.major;
    if (r.minor != l.minor) return r.minor > l.minor;
    return r.patch > l.patch;
}

const SemVer = struct { major: u32, minor: u32, patch: u32 };

fn parseVersion(s: []const u8) SemVer {
    const vstart: usize = if (s.len > 0 and s[0] == 'v') 1 else 0;
    const v = s[vstart..];
    var parts: [3]u32 = .{ 0, 0, 0 };
    var pi: usize = 0;
    var num_start: usize = 0;
    for (v, 0..) |c, i| {
        if (c == '.') {
            if (pi < 3) {
                parts[pi] = std.fmt.parseInt(u32, v[num_start..i], 10) catch 0;
                pi += 1;
            }
            num_start = i + 1;
        }
    }
    if (pi < 3) parts[pi] = std.fmt.parseInt(u32, v[num_start..], 10) catch 0;
    return .{ .major = parts[0], .minor = parts[1], .patch = parts[2] };
}

fn showUpdateAlert() void {
    const tag = pending_tag[0..pending_tag_len];
    const url = pending_url[0..pending_url_len];
    if (tag.len == 0 or url.len == 0) return;

    const NSAlert = objc.getClass("NSAlert") orelse return;
    const alert = objc.msgSend(NSAlert, objc.sel("new"));

    objc.msgSendVoid1(alert, objc.sel("setMessageText:"), objc.nsString("Update Available"));

    var msg_buf: [512]u8 = undefined;
    const msg = std.fmt.bufPrint(&msg_buf,
        "Stacks {s} is available (you have {s}).",
        .{ tag, version.string },
    ) catch "A new version is available.";
    objc.msgSendVoid1(alert, objc.sel("setInformativeText:"), objc.nsString(msg));

    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Update Now"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Release Notes"));
    objc.msgSendVoid1(alert, objc.sel("addButtonWithTitle:"), objc.nsString("Later"));

    // Center over main window
    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    const main_window = objc.msgSend(nsapp, objc.sel("mainWindow"));
    if (@intFromPtr(main_window) != 0) {
        const alert_window = objc.msgSend(alert, objc.sel("window"));
        objc.msgSendVoid(alert_window, objc.sel("layoutIfNeeded"));
        const main_frame = objc.msgSendRect(main_window, objc.sel("frame"));
        const alert_frame = objc.msgSendRect(alert_window, objc.sel("frame"));
        const cx = main_frame.origin.x + (main_frame.size.width - alert_frame.size.width) / 2.0;
        const cy = main_frame.origin.y + (main_frame.size.height - alert_frame.size.height) / 2.0;
        const setFrameOrigin: *const fn (objc.id, objc.SEL, objc.NSPoint) callconv(.c) void =
            @ptrCast(&objc.c.objc_msgSend);
        setFrameOrigin(alert_window, objc.sel("setFrameOrigin:"), .{ .x = cx, .y = cy });
    }

    const NSAlertFirstButtonReturn: objc.NSUInteger = 1000;
    const result = objc.msgSendUInt(alert, objc.sel("runModal"));
    if (result == NSAlertFirstButtonReturn) {
        downloadAndInstall(url);
    } else if (result == NSAlertFirstButtonReturn + 1) {
        // "Release Notes" — open in browser, then re-show the alert
        var notes_url_buf: [256]u8 = undefined;
        const notes_url = std.fmt.bufPrint(&notes_url_buf, "{s}{s}", .{ RELEASE_NOTES_BASE, tag }) catch return;
        const NSURL = objc.getClass("NSURL") orelse return;
        const ns_url = objc.msgSend1(NSURL, objc.sel("URLWithString:"), objc.nsString(notes_url));
        if (@intFromPtr(ns_url) != 0) {
            const NSWorkspace = objc.getClass("NSWorkspace") orelse return;
            const workspace = objc.msgSend(NSWorkspace, objc.sel("sharedWorkspace"));
            objc.msgSendVoid1(workspace, objc.sel("openURL:"), ns_url);
        }
        // Re-show the alert so they can still update
        showUpdateAlert();
    }
}

fn downloadAndInstall(url: []const u8) void {
    const tmp_zip = "/tmp/stacks-update.zip";
    const tmp_dir = "/tmp/stacks-update";
    const home = std.posix.getenv("HOME") orelse return;
    var dest_buf: [512]u8 = undefined;
    const dest = std.fmt.bufPrint(&dest_buf, "{s}/Applications/Stacks.app", .{home}) catch return;

    // Download
    {
        var dl = std.process.Child.init(
            &[_][]const u8{ "curl", "-sfL", "-o", tmp_zip, url },
            allocator,
        );
        dl.stdout_behavior = .Ignore;
        dl.stderr_behavior = .Ignore;
        dl.spawn() catch return;
        _ = dl.wait() catch return;
    }

    // Extract
    {
        var rm = std.process.Child.init(&[_][]const u8{ "rm", "-rf", tmp_dir }, allocator);
        rm.spawn() catch {};
        _ = rm.wait() catch {};
    }
    std.fs.makeDirAbsolute(tmp_dir) catch {};
    {
        var unzip = std.process.Child.init(
            &[_][]const u8{ "unzip", "-qo", tmp_zip, "-d", tmp_dir },
            allocator,
        );
        unzip.spawn() catch return;
        _ = unzip.wait() catch return;
    }

    // Replace app
    {
        var rm = std.process.Child.init(&[_][]const u8{ "rm", "-rf", dest }, allocator);
        rm.spawn() catch {};
        _ = rm.wait() catch {};
    }
    {
        var src_buf: [512]u8 = undefined;
        const src = std.fmt.bufPrint(&src_buf, "{s}/Stacks.app", .{tmp_dir}) catch return;
        var cp = std.process.Child.init(&[_][]const u8{ "cp", "-R", src, dest }, allocator);
        cp.spawn() catch return;
        _ = cp.wait() catch return;
    }

    // Relaunch and quit
    {
        var open = std.process.Child.init(&[_][]const u8{ "open", "-n", dest }, allocator);
        open.spawn() catch return;
    }
    const NSApp_class = objc.getClass("NSApplication") orelse return;
    const nsapp = objc.msgSend(NSApp_class, objc.sel("sharedApplication"));
    objc.msgSendVoid1(nsapp, objc.sel("terminate:"), nsapp);
}
