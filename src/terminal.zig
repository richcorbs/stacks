/// Terminal session management with split-pane support via libghostty.
///
/// Each "tab" in a project view holds a SplitTree — a binary tree where:
///   - Leaf nodes are individual terminal surfaces (ghostty_surface_t)
///   - Interior nodes define a horizontal or vertical split with a ratio
///
/// This mirrors Ghostty's own split model and maps to NSSplitView on macOS.
const std = @import("std");
const ghostty = @import("ghostty.zig");
const objc = @import("objc.zig");

// ---------------------------------------------------------------------------
// Split tree
// ---------------------------------------------------------------------------

pub const SplitDirection = enum {
    horizontal, // side-by-side (left | right)
    vertical, // stacked (top / bottom)
};

pub const SplitNode = union(enum) {
    leaf: Leaf,
    split: Split,
};

pub const Leaf = struct {
    surface: ghostty.Surface,
    /// The NSView that hosts the Metal layer for this surface.
    view: ?objc.id = null,
    /// Unique id within the tab for keying.
    id: u32,
};

pub const Split = struct {
    direction: SplitDirection,
    ratio: f64, // 0.0–1.0, proportion of space given to `first`
    first: *SplitNode,
    second: *SplitNode,
};

/// A tab is a named root of a split tree plus metadata.
pub const Tab = struct {
    label: []const u8,
    root: *SplitNode,
    /// The NSSplitView (or plain NSView for a single leaf) for this tab.
    container_view: ?objc.id = null,
    focused_leaf_id: u32 = 0,
};

// ---------------------------------------------------------------------------
// Session — one per project-view (e.g. "proj1:custom:abc")
// ---------------------------------------------------------------------------

pub const Session = struct {
    allocator: std.mem.Allocator,
    tabs: std.array_list.AlignedManaged(Tab, null),
    active_tab: usize = 0,
    next_leaf_id: u32 = 1,
    project_id: []const u8,
    kind: []const u8,
    /// Working directory for new surfaces in this session.
    cwd: []const u8,

    pub fn init(allocator: std.mem.Allocator, project_id: []const u8, kind: []const u8, cwd: []const u8) !Session {
        return .{
            .allocator = allocator,
            .tabs = std.array_list.AlignedManaged(Tab, null).init(allocator),
            .project_id = try allocator.dupe(u8, project_id),
            .kind = try allocator.dupe(u8, kind),
            .cwd = try allocator.dupe(u8, cwd),
        };
    }

    pub fn deinit(self: *Session) void {
        for (self.tabs.items) |*tab| {
            self.destroyNode(tab.root);
        }
        self.tabs.deinit();
        self.allocator.free(self.project_id);
        self.allocator.free(self.kind);
        self.allocator.free(self.cwd);
    }

    /// Add a new tab with a single terminal leaf.
    pub fn addTab(self: *Session, label: []const u8, initial_command: ?[]const u8) !*Tab {
        const leaf_id = self.next_leaf_id;
        self.next_leaf_id += 1;

        const surface = try ghostty.createSurface(.{
            .cwd = self.cwd,
            .command = initial_command,
        });

        const leaf_node = try self.allocator.create(SplitNode);
        leaf_node.* = .{ .leaf = .{
            .surface = surface,
            .id = leaf_id,
        } };

        const owned_label = try self.allocator.dupe(u8, label);
        try self.tabs.append(.{
            .label = owned_label,
            .root = leaf_node,
            .focused_leaf_id = leaf_id,
        });

        self.active_tab = self.tabs.items.len - 1;
        return &self.tabs.items[self.tabs.items.len - 1];
    }

    /// Split the currently focused leaf in the active tab.
    pub fn splitFocused(self: *Session, direction: SplitDirection) !*Leaf {
        if (self.tabs.items.len == 0) return error.NoTabs;
        const tab = &self.tabs.items[self.active_tab];
        const target_id = tab.focused_leaf_id;

        // Find the leaf node to split
        const leaf_node = findLeafNode(tab.root, target_id) orelse return error.LeafNotFound;

        // Create a new surface for the new pane
        const new_leaf_id = self.next_leaf_id;
        self.next_leaf_id += 1;

        // Inherit CWD from the existing surface if possible
        const new_cwd = ghostty.surfaceCwd(leaf_node.leaf.surface) orelse self.cwd;
        const new_surface = try ghostty.createSurface(.{ .cwd = new_cwd });

        // Create the new leaf node
        const new_leaf_node = try self.allocator.create(SplitNode);
        new_leaf_node.* = .{ .leaf = .{
            .surface = new_surface,
            .id = new_leaf_id,
        } };

        // Clone the old leaf into a new node (the original node becomes the split)
        const old_leaf_copy = try self.allocator.create(SplitNode);
        old_leaf_copy.* = leaf_node.*;

        // Replace the old leaf with a split
        leaf_node.* = .{ .split = .{
            .direction = direction,
            .ratio = 0.5,
            .first = old_leaf_copy,
            .second = new_leaf_node,
        } };

        // Focus the new pane
        tab.focused_leaf_id = new_leaf_id;

        return &new_leaf_node.leaf;
    }

    /// Close a leaf by ID. If it's the last leaf in a tab, the tab is removed.
    /// Returns true if the entire tab was removed.
    pub fn closeLeaf(self: *Session, tab_index: usize, leaf_id: u32) !bool {
        if (tab_index >= self.tabs.items.len) return error.InvalidTab;
        var tab = &self.tabs.items[tab_index];

        // If root is the target leaf, remove the whole tab
        switch (tab.root.*) {
            .leaf => |leaf| {
                if (leaf.id == leaf_id) {
                    ghostty.destroySurface(leaf.surface);
                    self.allocator.destroy(tab.root);
                    _ = self.tabs.orderedRemove(tab_index);
                    if (self.active_tab >= self.tabs.items.len and self.tabs.items.len > 0) {
                        self.active_tab = self.tabs.items.len - 1;
                    }
                    return true;
                }
                return error.LeafNotFound;
            },
            .split => {},
        }

        // Otherwise, remove from the tree
        const removed = try removeLeafFromTree(self.allocator, &tab.root, leaf_id);
        if (!removed) return error.LeafNotFound;

        // If the focused leaf was closed, pick the first remaining leaf
        if (tab.focused_leaf_id == leaf_id) {
            tab.focused_leaf_id = firstLeafId(tab.root);
        }

        return false;
    }

    /// Close the currently focused leaf in the active tab.
    pub fn closeFocused(self: *Session) !bool {
        if (self.tabs.items.len == 0) return error.NoTabs;
        const tab = &self.tabs.items[self.active_tab];
        return self.closeLeaf(self.active_tab, tab.focused_leaf_id);
    }

    /// Close the active tab (destroying all its surfaces).
    pub fn closeTab(self: *Session, tab_index: usize) !void {
        if (tab_index >= self.tabs.items.len) return error.InvalidTab;
        const tab = self.tabs.items[tab_index];
        self.destroyNode(tab.root);
        _ = self.tabs.orderedRemove(tab_index);
        if (self.active_tab >= self.tabs.items.len and self.tabs.items.len > 0) {
            self.active_tab = self.tabs.items.len - 1;
        }
    }

    /// Cycle focus to the next/previous leaf within the active tab.
    pub fn cycleFocus(self: *Session, forward: bool) void {
        if (self.tabs.items.len == 0) return;
        const tab = &self.tabs.items[self.active_tab];
        var leaves = std.array_list.AlignedManaged(u32, null).init(self.allocator);
        defer leaves.deinit();
        collectLeafIds(tab.root, &leaves) catch return;
        if (leaves.items.len <= 1) return;

        for (leaves.items, 0..) |id, i| {
            if (id == tab.focused_leaf_id) {
                const next = if (forward)
                    (i + 1) % leaves.items.len
                else
                    (i + leaves.items.len - 1) % leaves.items.len;
                tab.focused_leaf_id = leaves.items[next];
                return;
            }
        }
    }

    /// Adjust the split ratio for the parent of the focused leaf.
    pub fn adjustRatio(self: *Session, delta: f64) void {
        if (self.tabs.items.len == 0) return;
        const tab = &self.tabs.items[self.active_tab];
        if (findParentSplit(tab.root, tab.focused_leaf_id)) |split| {
            split.ratio = std.math.clamp(split.ratio + delta, 0.1, 0.9);
        }
    }

    /// Get the active tab (or null).
    pub fn activeTab(self: *Session) ?*Tab {
        if (self.tabs.items.len == 0) return null;
        return &self.tabs.items[self.active_tab];
    }

    /// Get the focused leaf in the active tab (or null).
    pub fn focusedLeaf(self: *Session) ?*Leaf {
        const tab = self.activeTab() orelse return null;
        const node = findLeafNode(tab.root, tab.focused_leaf_id) orelse return null;
        return &node.leaf;
    }

    /// Resize all surfaces in the active tab to match new view dimensions.
    pub fn resizeAllSurfaces(self: *Session, total_cols: u16, total_rows: u16) void {
        const tab = self.activeTab() orelse return;
        resizeTree(tab.root, total_cols, total_rows);
    }

    /// Write input data to the focused surface.
    pub fn writeToFocused(self: *Session, data: []const u8) void {
        const leaf = self.focusedLeaf() orelse return;
        ghostty.surfaceWrite(leaf.surface, data);
    }

    // ---- internal helpers ----

    fn destroyNode(self: *Session, node: *SplitNode) void {
        switch (node.*) {
            .leaf => |leaf| ghostty.destroySurface(leaf.surface),
            .split => |split| {
                self.destroyNode(split.first);
                self.destroyNode(split.second);
            },
        }
        self.allocator.destroy(node);
    }
};

// ---------------------------------------------------------------------------
// Tree traversal helpers
// ---------------------------------------------------------------------------

fn findLeafNode(node: *SplitNode, leaf_id: u32) ?*SplitNode {
    switch (node.*) {
        .leaf => |leaf| {
            if (leaf.id == leaf_id) return node;
            return null;
        },
        .split => |split| {
            return findLeafNode(split.first, leaf_id) orelse findLeafNode(split.second, leaf_id);
        },
    }
}

fn firstLeafId(node: *SplitNode) u32 {
    switch (node.*) {
        .leaf => |leaf| return leaf.id,
        .split => |split| return firstLeafId(split.first),
    }
}

fn collectLeafIds(node: *SplitNode, list: *std.array_list.AlignedManaged(u32, null)) !void {
    switch (node.*) {
        .leaf => |leaf| try list.append(leaf.id),
        .split => |split| {
            try collectLeafIds(split.first, list);
            try collectLeafIds(split.second, list);
        },
    }
}

fn findParentSplit(node: *SplitNode, leaf_id: u32) ?*Split {
    switch (node.*) {
        .leaf => return null,
        .split => |*split| {
            // Check if either child is the target leaf
            switch (split.first.*) {
                .leaf => |leaf| if (leaf.id == leaf_id) return split,
                else => {},
            }
            switch (split.second.*) {
                .leaf => |leaf| if (leaf.id == leaf_id) return split,
                else => {},
            }
            // Recurse
            return findParentSplit(split.first, leaf_id) orelse findParentSplit(split.second, leaf_id);
        },
    }
}

/// Remove a leaf from the split tree, collapsing its parent split.
/// Returns true if the leaf was found and removed.
fn removeLeafFromTree(allocator: std.mem.Allocator, node_ptr: **SplitNode, leaf_id: u32) !bool {
    const node = node_ptr.*;
    switch (node.*) {
        .leaf => return false,
        .split => |split| {
            // Check if first child is the target
            switch (split.first.*) {
                .leaf => |leaf| {
                    if (leaf.id == leaf_id) {
                        ghostty.destroySurface(leaf.surface);
                        allocator.destroy(split.first);
                        // Replace parent with second child
                        const second = split.second;
                        node_ptr.* = second;
                        allocator.destroy(node);
                        return true;
                    }
                },
                else => {},
            }
            // Check if second child is the target
            switch (split.second.*) {
                .leaf => |leaf| {
                    if (leaf.id == leaf_id) {
                        ghostty.destroySurface(leaf.surface);
                        allocator.destroy(split.second);
                        // Replace parent with first child
                        const first = split.first;
                        node_ptr.* = first;
                        allocator.destroy(node);
                        return true;
                    }
                },
                else => {},
            }
            // Recurse into children
            if (try removeLeafFromTree(allocator, &node.split.first, leaf_id)) return true;
            if (try removeLeafFromTree(allocator, &node.split.second, leaf_id)) return true;
            return false;
        },
    }
}

/// Recursively distribute columns/rows across a split tree.
fn resizeTree(node: *SplitNode, cols: u16, rows: u16) void {
    switch (node.*) {
        .leaf => |leaf| ghostty.surfaceResize(leaf.surface, cols, rows),
        .split => |split| {
            switch (split.direction) {
                .horizontal => {
                    const first_cols: u16 = @intFromFloat(@as(f64, @floatFromInt(cols)) * split.ratio);
                    const second_cols = if (cols > first_cols + 1) cols - first_cols - 1 else 1; // -1 for divider
                    resizeTree(split.first, first_cols, rows);
                    resizeTree(split.second, second_cols, rows);
                },
                .vertical => {
                    const first_rows: u16 = @intFromFloat(@as(f64, @floatFromInt(rows)) * split.ratio);
                    const second_rows = if (rows > first_rows + 1) rows - first_rows - 1 else 1;
                    resizeTree(split.first, cols, first_rows);
                    resizeTree(split.second, cols, second_rows);
                },
            }
        },
    }
}

/// Count the total number of leaves in a tree.
pub fn countLeaves(node: *const SplitNode) u32 {
    switch (node.*) {
        .leaf => return 1,
        .split => |split| return countLeaves(split.first) + countLeaves(split.second),
    }
}

/// Iterate over all leaves, calling `callback` for each.
pub fn forEachLeaf(node: *SplitNode, callback: *const fn (*Leaf) void) void {
    switch (node.*) {
        .leaf => |*leaf| callback(leaf),
        .split => |split| {
            forEachLeaf(split.first, callback);
            forEachLeaf(split.second, callback);
        },
    }
}

// ---------------------------------------------------------------------------
// Session registry — maps "projectId:kind" → Session
// ---------------------------------------------------------------------------

pub const SessionKey = struct {
    project_id: []const u8,
    kind: []const u8,
};

pub const SessionRegistry = struct {
    allocator: std.mem.Allocator,
    sessions: std.StringHashMap(Session),

    pub fn init(allocator: std.mem.Allocator) SessionRegistry {
        return .{
            .allocator = allocator,
            .sessions = std.StringHashMap(Session).init(allocator),
        };
    }

    pub fn deinit(self: *SessionRegistry) void {
        var it = self.sessions.valueIterator();
        while (it.next()) |session| {
            session.deinit();
        }
        self.sessions.deinit();
    }

    fn makeKey(self: *SessionRegistry, project_id: []const u8, kind: []const u8) ![]const u8 {
        return std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ project_id, kind });
    }

    /// Get or create a session for a project view.
    pub fn getOrCreate(self: *SessionRegistry, project_id: []const u8, kind: []const u8, cwd: []const u8) !*Session {
        const key = try self.makeKey(project_id, kind);

        if (self.sessions.getPtr(key)) |existing| {
            self.allocator.free(key);
            return existing;
        }

        var session = try Session.init(self.allocator, project_id, kind, cwd);
        // Add a default first tab
        _ = try session.addTab("1", null);
        try self.sessions.put(key, session);
        return self.sessions.getPtr(key).?;
    }

    /// Get a session if it exists.
    pub fn get(self: *SessionRegistry, project_id: []const u8, kind: []const u8) ?*Session {
        const key = std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ project_id, kind }) catch return null;
        defer self.allocator.free(key);
        return self.sessions.getPtr(key);
    }

    /// Destroy all sessions for a project.
    pub fn destroyForProject(self: *SessionRegistry, project_id: []const u8) void {
        var to_remove = std.array_list.AlignedManaged([]const u8, null).init(self.allocator);
        defer to_remove.deinit();

        var it = self.sessions.iterator();
        while (it.next()) |entry| {
            const prefix = std.fmt.allocPrint(self.allocator, "{s}:", .{project_id}) catch continue;
            defer self.allocator.free(prefix);
            if (std.mem.startsWith(u8, entry.key_ptr.*, prefix)) {
                to_remove.append(entry.key_ptr.*) catch continue;
            }
        }

        for (to_remove.items) |key| {
            if (self.sessions.fetchRemove(key)) |kv| {
                var session = kv.value;
                session.deinit();
            }
        }
    }

    /// Destroy a specific session.
    pub fn destroy(self: *SessionRegistry, project_id: []const u8, kind: []const u8) void {
        const key = std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ project_id, kind }) catch return;
        defer self.allocator.free(key);
        if (self.sessions.fetchRemove(key)) |kv| {
            var session = kv.value;
            session.deinit();
        }
    }

    /// Count total running shells.
    pub fn totalShells(self: *SessionRegistry) u32 {
        var count: u32 = 0;
        var it = self.sessions.valueIterator();
        while (it.next()) |session| {
            for (session.tabs.items) |tab| {
                count += countLeaves(tab.root);
            }
        }
        return count;
    }
};
