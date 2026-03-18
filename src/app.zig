/// Application state — the central hub connecting projects, terminals, and git.
const std = @import("std");
const project = @import("project.zig");
const terminal = @import("terminal.zig");
const ghostty = @import("ghostty.zig");
const git = @import("git.zig");

pub const ViewKind = union(enum) {
    git_panel,
    custom_terminal: []const u8, // terminal_id
};

pub const App = struct {
    allocator: std.mem.Allocator,
    store: project.ProjectStore,
    sessions: terminal.SessionRegistry,
    current_project_id: ?[]const u8 = null,
    current_view: ?ViewKind = null,

    pub fn init(allocator: std.mem.Allocator) !App {
        // Initialize the ghostty runtime
        try ghostty.initApp(.{
            .font_family = "Menlo",
            .font_size = 13.0,
        });

        return .{
            .allocator = allocator,
            .store = try project.ProjectStore.init(allocator),
            .sessions = terminal.SessionRegistry.init(allocator),
        };
    }

    pub fn deinit(self: *App) void {
        self.sessions.deinit();
        self.store.deinit();
        ghostty.deinitApp();
    }

    // ------------------------------------------------------------------
    // Project operations
    // ------------------------------------------------------------------

    pub fn addProject(self: *App, path: []const u8) !*project.Project {
        return self.store.addProject(path);
    }

    pub fn getProject(self: *App, project_id: []const u8) ?*project.Project {
        return self.store.findById(project_id);
    }

    pub fn projects(self: *App) []project.Project {
        return self.store.projects.items;
    }

    // ------------------------------------------------------------------
    // View selection
    // ------------------------------------------------------------------

    /// Select a project and view (git panel or a custom terminal).
    pub fn selectView(self: *App, project_id: []const u8, view: ViewKind) !void {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        self.current_project_id = proj.id;
        self.current_view = view;

        // For terminal views, ensure a session exists
        switch (view) {
            .custom_terminal => |terminal_id| {
                const kind = try std.fmt.allocPrint(self.allocator, "custom:{s}", .{terminal_id});
                defer self.allocator.free(kind);
                _ = try self.sessions.getOrCreate(proj.id, kind, proj.path);
            },
            .git_panel => {},
        }
    }

    /// Get the active session (if the current view is a terminal).
    pub fn activeSession(self: *App) ?*terminal.Session {
        const project_id = self.current_project_id orelse return null;
        const view = self.current_view orelse return null;
        switch (view) {
            .custom_terminal => |terminal_id| {
                const kind = std.fmt.allocPrint(self.allocator, "custom:{s}", .{terminal_id}) catch return null;
                defer self.allocator.free(kind);
                return self.sessions.get(project_id, kind);
            },
            .git_panel => return null,
        }
    }

    // ------------------------------------------------------------------
    // Terminal / split operations
    // ------------------------------------------------------------------

    /// Add a new tab to the active session.
    pub fn addTab(self: *App) !void {
        const session = self.activeSession() orelse return error.NoActiveSession;
        const tab_num = session.tabs.items.len + 1;
        const label = try std.fmt.allocPrint(self.allocator, "{d}", .{tab_num});
        defer self.allocator.free(label);
        _ = try session.addTab(label, null);
    }

    /// Close the active tab.
    pub fn closeActiveTab(self: *App) !void {
        const session = self.activeSession() orelse return error.NoActiveSession;
        try session.closeTab(session.active_tab);
    }

    /// Split the focused pane horizontally.
    pub fn splitHorizontal(self: *App) !void {
        const session = self.activeSession() orelse return error.NoActiveSession;
        _ = try session.splitFocused(.horizontal);
    }

    /// Split the focused pane vertically.
    pub fn splitVertical(self: *App) !void {
        const session = self.activeSession() orelse return error.NoActiveSession;
        _ = try session.splitFocused(.vertical);
    }

    /// Close the focused pane (closing the tab if it's the last one).
    pub fn closeFocusedPane(self: *App) !void {
        const session = self.activeSession() orelse return error.NoActiveSession;
        _ = try session.closeFocused();
    }

    /// Cycle focus to the next pane within the active tab.
    pub fn focusNextPane(self: *App) void {
        const session = self.activeSession() orelse return;
        session.cycleFocus(true);
    }

    /// Cycle focus to the previous pane within the active tab.
    pub fn focusPrevPane(self: *App) void {
        const session = self.activeSession() orelse return;
        session.cycleFocus(false);
    }

    /// Make the focused split larger.
    pub fn growPane(self: *App) void {
        const session = self.activeSession() orelse return;
        session.adjustRatio(0.05);
    }

    /// Make the focused split smaller.
    pub fn shrinkPane(self: *App) void {
        const session = self.activeSession() orelse return;
        session.adjustRatio(-0.05);
    }

    /// Switch to a specific tab by index.
    pub fn switchTab(self: *App, index: usize) void {
        const session = self.activeSession() orelse return;
        if (index < session.tabs.items.len) {
            session.active_tab = index;
        }
    }

    /// Cycle to next/previous tab.
    pub fn cycleTab(self: *App, forward: bool) void {
        const session = self.activeSession() orelse return;
        if (session.tabs.items.len <= 1) return;
        if (forward) {
            session.active_tab = (session.active_tab + 1) % session.tabs.items.len;
        } else {
            session.active_tab = (session.active_tab + session.tabs.items.len - 1) % session.tabs.items.len;
        }
    }

    /// Write input to the focused terminal.
    pub fn writeInput(self: *App, data: []const u8) void {
        const session = self.activeSession() orelse return;
        session.writeToFocused(data);
    }

    // ------------------------------------------------------------------
    // Git operations (delegate to git.zig using the project's path)
    // ------------------------------------------------------------------

    pub fn gitOverview(self: *App, project_id: []const u8, override_path: ?[]const u8) !git.GitOverview {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.getOverview(self.allocator, cwd);
    }

    pub fn gitLog(self: *App, project_id: []const u8, limit: u32, override_path: ?[]const u8) !std.array_list.AlignedManaged([]const u8, null) {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.getLog(self.allocator, cwd, limit);
    }

    pub fn gitStageFile(self: *App, project_id: []const u8, file_path: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.stageFile(self.allocator, cwd, file_path);
    }

    pub fn gitUnstageFile(self: *App, project_id: []const u8, file_path: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.unstageFile(self.allocator, cwd, file_path);
    }

    pub fn gitCommitAll(self: *App, project_id: []const u8, message: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.commitAll(self.allocator, cwd, message);
    }

    pub fn gitCommitStaged(self: *App, project_id: []const u8, message: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.commitStaged(self.allocator, cwd, message);
    }

    pub fn gitPush(self: *App, project_id: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.push(self.allocator, cwd);
    }

    pub fn gitPull(self: *App, project_id: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.pull(self.allocator, cwd);
    }

    pub fn gitInit(self: *App, project_id: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.initRepo(self.allocator, cwd);
    }

    pub fn gitSwitchBranch(self: *App, project_id: []const u8, branch: []const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        return git.switchBranch(self.allocator, proj.path, branch);
    }

    pub fn gitCreateBranch(self: *App, project_id: []const u8, branch: []const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        return git.createBranch(self.allocator, proj.path, branch);
    }

    pub fn gitDeleteBranch(self: *App, project_id: []const u8, branch: []const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        return git.deleteBranch(self.allocator, proj.path, branch);
    }

    pub fn gitMergeBranch(self: *App, project_id: []const u8, branch: []const u8, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.mergeBranch(self.allocator, cwd, branch);
    }

    pub fn gitFileDiff(self: *App, project_id: []const u8, file_path: []const u8, is_untracked: bool, override_path: ?[]const u8) !git.GitResult {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        const cwd = override_path orelse proj.path;
        return git.fileDiff(self.allocator, cwd, file_path, is_untracked);
    }

    pub fn gitWorktreeList(self: *App, project_id: []const u8) !std.array_list.AlignedManaged(git.Worktree, null) {
        const proj = self.store.findById(project_id) orelse return error.ProjectNotFound;
        return git.getWorktrees(self.allocator, proj.path);
    }

    // ------------------------------------------------------------------
    // Shutdown
    // ------------------------------------------------------------------

    /// Count total running terminal processes.
    pub fn runningShellCount(self: *App) u32 {
        return self.sessions.totalShells();
    }
};
