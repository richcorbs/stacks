/// Project management — CRUD, persistence, and data model.
/// CRUD operations, JSON persistence, and data model for projects and terminals.
const std = @import("std");

pub const Terminal = struct {
    id: []const u8,
    name: []const u8,
    command: ?[]const u8 = null,
    splits: ?[]const u8 = null, // serialized split tree, e.g. "h(leaf,leaf)"
    cwd: ?[]const u8 = null, // last known working directory
};

pub const ItemVisibility = struct {
    git: bool = true,
};

pub const ItemNames = struct {
    git: []const u8 = "Git",
};

pub const Project = struct {
    id: []const u8,
    name: []const u8,
    path: []const u8,
    terminals: std.array_list.AlignedManaged(Terminal, null),
    collapsed: bool = false,
    item_names: ItemNames = .{},
    item_visibility: ItemVisibility = .{},

    pub fn deinit(self: *Project, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.name);
        allocator.free(self.path);
        for (self.terminals.items) |t| {
            allocator.free(t.id);
            allocator.free(t.name);
            if (t.command) |cmd| allocator.free(cmd);
            if (t.splits) |splits| allocator.free(splits);
            if (t.cwd) |cwd| allocator.free(cwd);
        }
        self.terminals.deinit();
        if (@intFromPtr(self.item_names.git.ptr) != @intFromPtr("Git".ptr)) {
            allocator.free(self.item_names.git);
        }
    }
};

pub const ProjectStore = struct {
    allocator: std.mem.Allocator,
    projects: std.array_list.AlignedManaged(Project, null),
    file_path: []const u8,

    pub fn init(allocator: std.mem.Allocator) !ProjectStore {
        // Determine config directory: ~/Library/Application Support/stacks/projects.json
        const home = std.posix.getenv("HOME") orelse "/tmp";
        const dir = try std.fmt.allocPrint(allocator, "{s}/Library/Application Support/stacks", .{home});
        std.fs.makeDirAbsolute(dir) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return err,
        };
        const file_path = try std.fmt.allocPrint(allocator, "{s}/projects.json", .{dir});
        allocator.free(dir);

        var store = ProjectStore{
            .allocator = allocator,
            .projects = std.array_list.AlignedManaged(Project, null).init(allocator),
            .file_path = file_path,
        };

        store.load() catch {}; // Ignore if file doesn't exist yet
        return store;
    }

    pub fn deinit(self: *ProjectStore) void {
        for (self.projects.items) |*p| p.deinit(self.allocator);
        self.projects.deinit();
        self.allocator.free(self.file_path);
    }

    /// Generate a unique ID.
    pub fn generateId(self: *ProjectStore) ![]const u8 {
        const ts = std.time.milliTimestamp();
        var prng = std.Random.DefaultPrng.init(@bitCast(ts));
        const rand = prng.random().int(u32);
        return std.fmt.allocPrint(self.allocator, "{d}-{x:0>8}", .{ ts, rand });
    }

    /// Add a project from a directory path. Returns the project or null if it already exists.
    pub fn addProject(self: *ProjectStore, dir_path: []const u8) !*Project {
        // Check for duplicate
        for (self.projects.items) |*p| {
            if (std.mem.eql(u8, p.path, dir_path)) return p;
        }

        const id = try self.generateId();
        const name = std.fs.path.basename(dir_path);
        const name_owned = try self.allocator.dupe(u8, name);
        const path_owned = try self.allocator.dupe(u8, dir_path);

        try self.projects.append(.{
            .id = id,
            .name = name_owned,
            .path = path_owned,
            .terminals = std.array_list.AlignedManaged(Terminal, null).init(self.allocator),
        });

        try self.save();
        return &self.projects.items[self.projects.items.len - 1];
    }

    /// Find a project by ID.
    pub fn findById(self: *ProjectStore, project_id: []const u8) ?*Project {
        for (self.projects.items) |*p| {
            if (std.mem.eql(u8, p.id, project_id)) return p;
        }
        return null;
    }

    /// Add a terminal to a project.
    pub fn addTerminal(self: *ProjectStore, project_id: []const u8, name: []const u8, command: ?[]const u8) !*Terminal {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        const id = try self.generateId();
        const name_owned = try self.allocator.dupe(u8, name);
        const cmd_owned: ?[]const u8 = if (command) |c| try self.allocator.dupe(u8, c) else null;

        try project.terminals.append(.{
            .id = id,
            .name = name_owned,
            .command = cmd_owned,
        });

        try self.save();
        return &project.terminals.items[project.terminals.items.len - 1];
    }

    /// Delete a terminal from a project.
    pub fn deleteTerminal(self: *ProjectStore, project_id: []const u8, terminal_id: []const u8) !void {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        for (project.terminals.items, 0..) |t, i| {
            if (std.mem.eql(u8, t.id, terminal_id)) {
                // Free owned strings before removing
                self.allocator.free(t.id);
                self.allocator.free(t.name);
                if (t.command) |cmd| self.allocator.free(cmd);
                if (t.splits) |s| self.allocator.free(s);
                if (t.cwd) |c| self.allocator.free(c);
                _ = project.terminals.orderedRemove(i);
                try self.save();
                return;
            }
        }
        return error.TerminalNotFound;
    }

    /// Rename a terminal.
    pub fn renameTerminal(self: *ProjectStore, project_id: []const u8, terminal_id: []const u8, new_name: []const u8) !void {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        for (project.terminals.items) |*t| {
            if (std.mem.eql(u8, t.id, terminal_id)) {
                const name_owned = try self.allocator.dupe(u8, new_name);
                t.name = name_owned;
                try self.save();
                return;
            }
        }
        return error.TerminalNotFound;
    }

    /// Update a project's name and/or path.
    pub fn updateProject(self: *ProjectStore, project_id: []const u8, new_name: []const u8, new_path: []const u8) !void {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        if (new_name.len > 0) {
            const name_owned = try self.allocator.dupe(u8, new_name);
            self.allocator.free(project.name);
            project.name = name_owned;
        }
        if (new_path.len > 0) {
            const path_owned = try self.allocator.dupe(u8, new_path);
            self.allocator.free(project.path);
            project.path = path_owned;
        }
        try self.save();
    }

    pub fn setProjectCollapsed(self: *ProjectStore, project_id: []const u8, collapsed: bool) !void {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        project.collapsed = collapsed;
        try self.save();
    }

    /// Reorder projects by ID list.
    pub fn reorder(self: *ProjectStore, ordered_ids: []const []const u8) !void {
        var new_list = std.array_list.AlignedManaged(Project, null).init(self.allocator);

        // Add in requested order
        for (ordered_ids) |id| {
            for (self.projects.items, 0..) |p, i| {
                if (std.mem.eql(u8, p.id, id)) {
                    try new_list.append(p);
                    _ = self.projects.orderedRemove(i);
                    break;
                }
            }
        }

        // Append any remaining (not in ordered_ids)
        for (self.projects.items) |p| {
            try new_list.append(p);
        }

        self.projects.deinit();
        self.projects = new_list;
        try self.save();
    }

    /// Reorder terminals within a project.
    pub fn reorderTerminals(self: *ProjectStore, project_id: []const u8, ordered_ids: []const []const u8) !void {
        const project = self.findById(project_id) orelse return error.ProjectNotFound;
        var new_list = std.array_list.AlignedManaged(Terminal, null).init(self.allocator);

        for (ordered_ids) |id| {
            for (project.terminals.items, 0..) |t, i| {
                if (std.mem.eql(u8, t.id, id)) {
                    try new_list.append(t);
                    _ = project.terminals.orderedRemove(i);
                    break;
                }
            }
        }

        for (project.terminals.items) |t| {
            try new_list.append(t);
        }

        project.terminals.deinit();
        project.terminals = new_list;
        try self.save();
    }

    /// Save all projects to disk as JSON.
    pub fn save(self: *ProjectStore) !void {
        // Build JSON in memory then write at once
        var buf = std.array_list.AlignedManaged(u8, null).init(self.allocator);
        defer buf.deinit();
        const w = buf.writer();

        try w.writeAll("[\n");
        for (self.projects.items, 0..) |p, pi| {
            if (pi > 0) try w.writeAll(",\n");
            try w.writeAll("  {\n");
            try w.print("    \"id\": \"{s}\",\n", .{p.id});
            try w.print("    \"name\": \"{s}\",\n", .{p.name});
            try w.print("    \"path\": \"{s}\",\n", .{p.path});
            try w.print("    \"collapsed\": {s},\n", .{if (p.collapsed) "true" else "false"});
            try w.writeAll("    \"terminals\": [");
            for (p.terminals.items, 0..) |t, ti| {
                if (ti > 0) try w.writeAll(", ");
                try w.writeAll("{");
                try w.print("\"id\":\"{s}\",\"name\":\"{s}\"", .{ t.id, t.name });
                if (t.command) |cmd| {
                    try w.print(",\"command\":\"{s}\"", .{cmd});
                }
                if (t.splits) |splits| {
                    try w.print(",\"splits\":\"{s}\"", .{splits});
                }
                if (t.cwd) |cwd_val| {
                    try w.print(",\"cwd\":\"{s}\"", .{cwd_val});
                }
                try w.writeAll("}");
            }
            try w.writeAll("],\n");
            try w.print("    \"itemNames\": {{\"git\": \"{s}\"}},\n", .{p.item_names.git});
            try w.print("    \"itemVisibility\": {{\"git\": {s}}}\n", .{if (p.item_visibility.git) "true" else "false"});
            try w.writeAll("  }");
        }
        try w.writeAll("\n]\n");

        var file = try std.fs.createFileAbsolute(self.file_path, .{});
        defer file.close();
        try file.writeAll(buf.items);
    }

    /// Load projects from disk.
    pub fn load(self: *ProjectStore) !void {
        const file = std.fs.openFileAbsolute(self.file_path, .{}) catch return;
        defer file.close();

        const content = try file.readToEndAlloc(self.allocator, 10 * 1024 * 1024);
        defer self.allocator.free(content);

        const parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, content, .{});
        defer parsed.deinit();

        const root = parsed.value;
        if (root != .array) return;

        for (root.array.items) |item| {
            if (item != .object) continue;
            const obj = item.object;

            const id_val = obj.get("id") orelse continue;
            const name_val = obj.get("name") orelse continue;
            const path_val = obj.get("path") orelse continue;

            if (id_val != .string or name_val != .string or path_val != .string) continue;

            const id = try self.allocator.dupe(u8, id_val.string);
            const name = try self.allocator.dupe(u8, name_val.string);
            const path = try self.allocator.dupe(u8, path_val.string);
            const collapsed = if (obj.get("collapsed")) |cv| blk: {
                break :blk if (cv == .bool) cv.bool else false;
            } else false;

            var terminals = std.array_list.AlignedManaged(Terminal, null).init(self.allocator);

            if (obj.get("terminals")) |terms_val| {
                if (terms_val == .array) {
                    for (terms_val.array.items) |term_item| {
                        if (term_item != .object) continue;
                        const tobj = term_item.object;
                        const tid = tobj.get("id") orelse continue;
                        const tname = tobj.get("name") orelse continue;
                        if (tid != .string or tname != .string) continue;

                        const tcmd = if (tobj.get("command")) |cv| blk: {
                            break :blk if (cv == .string) try self.allocator.dupe(u8, cv.string) else null;
                        } else null;

                        const tsplits = if (tobj.get("splits")) |sv| blk: {
                            break :blk if (sv == .string) try self.allocator.dupe(u8, sv.string) else null;
                        } else null;

                        const tcwd = if (tobj.get("cwd")) |cv| blk: {
                            break :blk if (cv == .string) try self.allocator.dupe(u8, cv.string) else null;
                        } else null;

                        try terminals.append(.{
                            .id = try self.allocator.dupe(u8, tid.string),
                            .name = try self.allocator.dupe(u8, tname.string),
                            .command = tcmd,
                            .splits = tsplits,
                            .cwd = tcwd,
                        });
                    }
                }
            }

            var item_names = ItemNames{};
            if (obj.get("itemNames")) |in_val| {
                if (in_val == .object) {
                    if (in_val.object.get("git")) |g| {
                        if (g == .string) item_names.git = try self.allocator.dupe(u8, g.string);
                    }
                }
            }

            var item_visibility = ItemVisibility{};
            if (obj.get("itemVisibility")) |iv_val| {
                if (iv_val == .object) {
                    if (iv_val.object.get("git")) |g| {
                        if (g == .bool) item_visibility.git = g.bool;
                    }
                }
            }

            try self.projects.append(.{
                .id = id,
                .name = name,
                .path = path,
                .terminals = terminals,
                .collapsed = collapsed,
                .item_names = item_names,
                .item_visibility = item_visibility,
            });
        }
    }
};

test "generate id" {
    const allocator = std.testing.allocator;
    var store = try ProjectStore.init(allocator);
    defer store.deinit();
    const id = try store.generateId();
    defer allocator.free(id);
    try std.testing.expect(id.len > 0);
}

test "updateProject changes name and path" {
    const allocator = std.testing.allocator;
    var store = try ProjectStore.init(allocator);
    defer store.deinit();

    const proj = try store.addProject("/tmp/test-project");
    const proj_id = try allocator.dupe(u8, proj.id);
    defer allocator.free(proj_id);

    try std.testing.expectEqualStrings("test-project", proj.name);
    try std.testing.expectEqualStrings("/tmp/test-project", proj.path);

    try store.updateProject(proj_id, "My Project", "/tmp/other-dir");

    const updated = store.findById(proj_id).?;
    try std.testing.expectEqualStrings("My Project", updated.name);
    try std.testing.expectEqualStrings("/tmp/other-dir", updated.path);
}

test "updateProject skips empty name or path" {
    const allocator = std.testing.allocator;
    var store = try ProjectStore.init(allocator);
    defer store.deinit();

    const proj = try store.addProject("/tmp/test-project2");
    const proj_id = try allocator.dupe(u8, proj.id);
    defer allocator.free(proj_id);

    // Empty name should not change it
    try store.updateProject(proj_id, "", "/tmp/new-path");
    const updated = store.findById(proj_id).?;
    try std.testing.expectEqualStrings("test-project2", updated.name);
    try std.testing.expectEqualStrings("/tmp/new-path", updated.path);

    // Empty path should not change it
    try store.updateProject(proj_id, "New Name", "");
    const updated2 = store.findById(proj_id).?;
    try std.testing.expectEqualStrings("New Name", updated2.name);
    try std.testing.expectEqualStrings("/tmp/new-path", updated2.path);
}

test "setProjectCollapsed updates persisted state" {
    const allocator = std.testing.allocator;
    var store = try ProjectStore.init(allocator);
    defer store.deinit();

    const proj = try store.addProject("/tmp/collapsible-project");
    const proj_id = try allocator.dupe(u8, proj.id);
    defer allocator.free(proj_id);

    try std.testing.expect(!proj.collapsed);

    try store.setProjectCollapsed(proj_id, true);
    const updated = store.findById(proj_id).?;
    try std.testing.expect(updated.collapsed);

    try store.setProjectCollapsed(proj_id, false);
    const updated2 = store.findById(proj_id).?;
    try std.testing.expect(!updated2.collapsed);
}
