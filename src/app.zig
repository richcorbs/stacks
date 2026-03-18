/// Application state — central hub for project data.
const std = @import("std");
const project = @import("project.zig");

pub const App = struct {
    allocator: std.mem.Allocator,
    store: project.ProjectStore,
    current_project_id: ?[]const u8 = null,
    current_terminal_id: ?[]const u8 = null,

    pub fn init(allocator: std.mem.Allocator) !App {
        return .{
            .allocator = allocator,
            .store = try project.ProjectStore.init(allocator),
        };
    }

    pub fn deinit(self: *App) void {
        self.store.deinit();
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
};
