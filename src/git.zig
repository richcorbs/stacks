/// Git operations — wraps command-line git, mirrors the Electron app's git:* handlers.
const std = @import("std");

pub const StatusEntry = struct {
    code: [2]u8,
    path: []const u8,
};

pub const GitOverview = struct {
    is_repo: bool = false,
    branch: ?[]const u8 = null,
    status: std.array_list.AlignedManaged(StatusEntry, null),
    branches: std.array_list.AlignedManaged([]const u8, null),
    ahead: u32 = 0,
    behind: u32 = 0,

    pub fn deinit(self: *GitOverview) void {
        self.status.deinit();
        self.branches.deinit();
    }
};

pub const Worktree = struct {
    path: []const u8,
    head: ?[]const u8 = null,
    branch: ?[]const u8 = null,
    bare: bool = false,
    detached: bool = false,
};

pub const GitResult = struct {
    ok: bool,
    stdout: []const u8,
    stderr: []const u8,
    allocator: std.mem.Allocator,

    pub fn deinit(self: *GitResult) void {
        self.allocator.free(self.stdout);
        self.allocator.free(self.stderr);
    }
};

/// Run a git command in the given directory.
pub fn runGit(allocator: std.mem.Allocator, cwd: []const u8, args: []const []const u8, allow_failure: bool) !GitResult {
    var argv = std.array_list.AlignedManaged([]const u8, null).init(allocator);
    defer argv.deinit();

    try argv.append("git");
    try argv.append("-C");
    try argv.append(cwd);
    for (args) |arg| try argv.append(arg);

    var child = std.process.Child.init(argv.items, allocator);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;

    try child.spawn();

    var stdout_buf = std.array_list.AlignedManaged(u8, null).init(allocator);
    var stderr_buf = std.array_list.AlignedManaged(u8, null).init(allocator);
    defer stdout_buf.deinit();
    defer stderr_buf.deinit();

    child.collectOutput(&stdout_buf, &stderr_buf, 1024 * 1024) catch {};
    const term = try child.wait();

    const stdout = try allocator.dupe(u8, std.mem.trimRight(u8, stdout_buf.items, "\n\r "));
    const stderr = try allocator.dupe(u8, std.mem.trimRight(u8, stderr_buf.items, "\n\r "));

    const ok = switch (term) {
        .Exited => |code| code == 0,
        else => false,
    };

    if (!ok and !allow_failure) {
        const msg = if (stderr.len > 0) stderr else stdout;
        _ = msg;
        return GitResult{
            .ok = false,
            .stdout = stdout,
            .stderr = stderr,
            .allocator = allocator,
        };
    }

    return GitResult{
        .ok = ok,
        .stdout = stdout,
        .stderr = stderr,
        .allocator = allocator,
    };
}

/// Parse `git status --porcelain` output into StatusEntry list.
pub fn parseStatus(allocator: std.mem.Allocator, text: []const u8) !std.array_list.AlignedManaged(StatusEntry, null) {
    var entries = std.array_list.AlignedManaged(StatusEntry, null).init(allocator);
    var lines = std.mem.splitScalar(u8, text, '\n');

    while (lines.next()) |line| {
        const trimmed = std.mem.trimRight(u8, line, "\r ");
        if (trimmed.len < 3) continue;

        try entries.append(.{
            .code = .{ trimmed[0], trimmed[1] },
            .path = try allocator.dupe(u8, std.mem.trim(u8, trimmed[3..], " ")),
        });
    }

    return entries;
}

/// Get a full overview of the git repository state.
pub fn getOverview(allocator: std.mem.Allocator, cwd: []const u8) !GitOverview {
    var overview = GitOverview{
        .status = std.array_list.AlignedManaged(StatusEntry, null).init(allocator),
        .branches = std.array_list.AlignedManaged([]const u8, null).init(allocator),
    };

    // Check if inside a git repo
    var inside = try runGit(allocator, cwd, &.{"rev-parse", "--is-inside-work-tree"}, true);
    defer inside.deinit();
    if (!inside.ok or !std.mem.eql(u8, inside.stdout, "true")) {
        return overview;
    }
    overview.is_repo = true;

    // Branch
    var branch_result = try runGit(allocator, cwd, &.{"branch", "--show-current"}, true);
    defer branch_result.deinit();
    if (branch_result.ok and branch_result.stdout.len > 0) {
        overview.branch = try allocator.dupe(u8, branch_result.stdout);
    } else {
        var head_result = try runGit(allocator, cwd, &.{ "rev-parse", "--short", "HEAD" }, true);
        defer head_result.deinit();
        if (head_result.ok and head_result.stdout.len > 0) {
            overview.branch = try std.fmt.allocPrint(allocator, "detached ({s})", .{head_result.stdout});
        } else {
            overview.branch = try allocator.dupe(u8, "detached");
        }
    }

    // Status
    var status_result = try runGit(allocator, cwd, &.{ "status", "--porcelain" }, true);
    defer status_result.deinit();
    if (status_result.ok) {
        overview.status = try parseStatus(allocator, status_result.stdout);
    }

    // Branch list
    var branch_list = try runGit(allocator, cwd, &.{ "branch", "--format", "%(refname:short)" }, true);
    defer branch_list.deinit();
    if (branch_list.ok and branch_list.stdout.len > 0) {
        var lines = std.mem.splitScalar(u8, branch_list.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \r");
            if (trimmed.len > 0) {
                try overview.branches.append(try allocator.dupe(u8, trimmed));
            }
        }
    }

    // Ahead/behind
    var ab_result = try runGit(allocator, cwd, &.{ "rev-list", "--left-right", "--count", "HEAD...@{upstream}" }, true);
    defer ab_result.deinit();
    if (ab_result.ok and ab_result.stdout.len > 0) {
        var parts = std.mem.splitAny(u8, ab_result.stdout, " \t");
        if (parts.next()) |ahead_str| {
            overview.ahead = std.fmt.parseInt(u32, ahead_str, 10) catch 0;
            if (parts.next()) |behind_str| {
                overview.behind = std.fmt.parseInt(u32, behind_str, 10) catch 0;
            }
        }
    }

    return overview;
}

/// Get git log entries.
pub fn getLog(allocator: std.mem.Allocator, cwd: []const u8, limit: u32) !std.array_list.AlignedManaged([]const u8, null) {
    var entries = std.array_list.AlignedManaged([]const u8, null).init(allocator);

    const max_str = try std.fmt.allocPrint(allocator, "--max-count={d}", .{limit});
    defer allocator.free(max_str);

    var result = try runGit(allocator, cwd, &.{
        "log",
        max_str,
        "--date=short",
        "--pretty=format:%h\t%ad\t%s",
    }, true);
    defer result.deinit();

    if (!result.ok or result.stdout.len == 0) return entries;

    var lines = std.mem.splitScalar(u8, result.stdout, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trimRight(u8, line, "\r ");
        if (trimmed.len > 0) {
            try entries.append(try allocator.dupe(u8, trimmed));
        }
    }

    return entries;
}

/// Get worktree list.
pub fn getWorktrees(allocator: std.mem.Allocator, cwd: []const u8) !std.array_list.AlignedManaged(Worktree, null) {
    var worktrees = std.array_list.AlignedManaged(Worktree, null).init(allocator);

    var result = try runGit(allocator, cwd, &.{ "worktree", "list", "--porcelain" }, true);
    defer result.deinit();

    if (!result.ok or result.stdout.len == 0) return worktrees;

    var current = Worktree{ .path = "" };
    var lines = std.mem.splitScalar(u8, result.stdout, '\n');

    while (lines.next()) |line| {
        if (line.len == 0) {
            if (current.path.len > 0) try worktrees.append(current);
            current = Worktree{ .path = "" };
        } else if (std.mem.startsWith(u8, line, "worktree ")) {
            current.path = try allocator.dupe(u8, line[9..]);
        } else if (std.mem.startsWith(u8, line, "HEAD ")) {
            current.head = try allocator.dupe(u8, line[5..]);
        } else if (std.mem.startsWith(u8, line, "branch ")) {
            const raw = line[7..];
            const prefix = "refs/heads/";
            if (std.mem.startsWith(u8, raw, prefix)) {
                current.branch = try allocator.dupe(u8, raw[prefix.len..]);
            } else {
                current.branch = try allocator.dupe(u8, raw);
            }
        } else if (std.mem.eql(u8, line, "bare")) {
            current.bare = true;
        } else if (std.mem.eql(u8, line, "detached")) {
            current.detached = true;
        }
    }
    if (current.path.len > 0) try worktrees.append(current);

    return worktrees;
}

/// Stage a file.
pub fn stageFile(allocator: std.mem.Allocator, cwd: []const u8, file_path: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "add", "--", file_path }, false);
}

/// Unstage a file.
pub fn unstageFile(allocator: std.mem.Allocator, cwd: []const u8, file_path: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "restore", "--staged", "--", file_path }, false);
}

/// Commit all changes.
pub fn commitAll(allocator: std.mem.Allocator, cwd: []const u8, message: []const u8) !GitResult {
    var add_result = try runGit(allocator, cwd, &.{ "add", "-A" }, false);
    add_result.deinit();
    return try runGit(allocator, cwd, &.{ "commit", "-m", message }, true);
}

/// Commit staged changes only.
pub fn commitStaged(allocator: std.mem.Allocator, cwd: []const u8, message: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "commit", "-m", message }, true);
}

/// Push.
pub fn push(allocator: std.mem.Allocator, cwd: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{"push"}, false);
}

/// Pull --ff-only.
pub fn pull(allocator: std.mem.Allocator, cwd: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "pull", "--ff-only" }, false);
}

/// Initialize a repository.
pub fn initRepo(allocator: std.mem.Allocator, cwd: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{"init"}, false);
}

/// Switch branch.
pub fn switchBranch(allocator: std.mem.Allocator, cwd: []const u8, branch: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "checkout", branch }, false);
}

/// Create and switch to a new branch.
pub fn createBranch(allocator: std.mem.Allocator, cwd: []const u8, branch: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "checkout", "-b", branch }, false);
}

/// Delete a branch.
pub fn deleteBranch(allocator: std.mem.Allocator, cwd: []const u8, branch: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "branch", "-d", branch }, false);
}

/// Merge a branch.
pub fn mergeBranch(allocator: std.mem.Allocator, cwd: []const u8, branch: []const u8) !GitResult {
    return try runGit(allocator, cwd, &.{ "merge", branch }, false);
}

/// Get file diff.
pub fn fileDiff(allocator: std.mem.Allocator, cwd: []const u8, file_path: []const u8, is_untracked: bool) !GitResult {
    if (is_untracked) {
        const abs_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ cwd, file_path });
        defer allocator.free(abs_path);
        return try runGit(allocator, cwd, &.{ "diff", "--no-color", "--no-index", "--", "/dev/null", abs_path }, true);
    }
    return try runGit(allocator, cwd, &.{ "diff", "--no-color", "HEAD", "--", file_path }, true);
}

/// Check if status entries have staged changes.
pub fn hasStagedChanges(entries: []const StatusEntry) bool {
    for (entries) |entry| {
        const index_code = entry.code[0];
        if (index_code != ' ' and index_code != '?') return true;
    }
    return false;
}

/// Resolve rename paths (e.g., "old -> new" => "new").
pub fn resolveStatusDiffPath(path: []const u8) []const u8 {
    const marker = " -> ";
    if (std.mem.indexOf(u8, path, marker)) |idx| {
        return std.mem.trim(u8, path[idx + marker.len ..], " ");
    }
    return path;
}
