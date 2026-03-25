/// Split tree — binary tree for split pane layouts.
///
/// Pure data structure with no UI dependencies. Used by term_text_view.zig
/// to manage split terminal panes.
const std = @import("std");

pub const SplitDirection = enum {
    horizontal, // side by side (left | right)
    vertical, // stacked (top / bottom)
};

pub const SplitNode = union(enum) {
    leaf: usize, // slot index into terminals[]
    split: struct {
        direction: SplitDirection,
        first: *SplitNode,
        second: *SplitNode,
        ratio: f64, // 0.0 - 1.0, portion for first child
    },

    /// Recursively destroy the tree, freeing all nodes.
    pub fn destroyTree(self: *SplitNode, allocator: std.mem.Allocator) void {
        switch (self.*) {
            .split => |s| {
                s.first.destroyTree(allocator);
                s.second.destroyTree(allocator);
                allocator.destroy(s.first);
                allocator.destroy(s.second);
            },
            .leaf => {},
        }
    }

    /// Collect all leaf slot indices into an array.
    pub fn collectLeaves(self: *SplitNode, allocator: std.mem.Allocator, out: *std.ArrayListUnmanaged(usize)) void {
        switch (self.*) {
            .leaf => |slot| {
                out.append(allocator, slot) catch {};
            },
            .split => |s| {
                s.first.collectLeaves(allocator, out);
                s.second.collectLeaves(allocator, out);
            },
        }
    }

    /// Find the leaf node containing the given slot.
    pub fn findLeaf(self: *SplitNode, slot: usize) ?*SplitNode {
        switch (self.*) {
            .leaf => |s| {
                if (s == slot) return self;
                return null;
            },
            .split => |s| {
                return s.first.findLeaf(slot) orelse s.second.findLeaf(slot);
            },
        }
    }

    /// Find the parent node of a given child.
    pub fn findParent(self: *SplitNode, child: *SplitNode) ?*SplitNode {
        switch (self.*) {
            .leaf => return null,
            .split => |s| {
                if (s.first == child or s.second == child) return self;
                return s.first.findParent(child) orelse s.second.findParent(child);
            },
        }
    }

    /// Count the number of leaves visible along a given axis.
    /// For a split in the same direction, both subtrees contribute.
    /// For a split in the other direction, only the max of the two subtrees counts.
    pub fn countLeavesAlongAxis(self: *SplitNode, direction: SplitDirection) usize {
        switch (self.*) {
            .leaf => return 1,
            .split => |s| {
                if (s.direction == direction) {
                    return s.first.countLeavesAlongAxis(direction) + s.second.countLeavesAlongAxis(direction);
                } else {
                    return @max(s.first.countLeavesAlongAxis(direction), s.second.countLeavesAlongAxis(direction));
                }
            },
        }
    }

    /// Rebalance all split ratios along a given axis so leaves get equal space.
    pub fn rebalanceAxis(self: *SplitNode, direction: SplitDirection) void {
        switch (self.*) {
            .leaf => {},
            .split => |*s| {
                if (s.direction == direction) {
                    const left_count = s.first.countLeavesAlongAxis(direction);
                    const right_count = s.second.countLeavesAlongAxis(direction);
                    const total: f64 = @floatFromInt(left_count + right_count);
                    s.ratio = @as(f64, @floatFromInt(left_count)) / total;
                }
                s.first.rebalanceAxis(direction);
                s.second.rebalanceAxis(direction);
            },
        }
    }

    /// Serialize split tree to compact string: "leaf", "h(leaf,leaf)", etc.
    /// Returns the slice of buf that was written to.
    pub fn serialize(self: *SplitNode, buf: []u8) []const u8 {
        var pos: usize = 0;
        self.serializeImpl(buf, &pos);
        return buf[0..pos];
    }

    fn serializeImpl(self: *SplitNode, buf: []u8, pos: *usize) void {
        switch (self.*) {
            .leaf => {
                const s = "leaf";
                if (pos.* + s.len <= buf.len) {
                    @memcpy(buf[pos.*..][0..s.len], s);
                    pos.* += s.len;
                }
            },
            .split => |sp| {
                const ch: u8 = if (sp.direction == .horizontal) 'h' else 'v';
                if (pos.* + 2 <= buf.len) {
                    buf[pos.*] = ch;
                    buf[pos.* + 1] = '(';
                    pos.* += 2;
                }
                sp.first.serializeImpl(buf, pos);
                if (pos.* + 1 <= buf.len) {
                    buf[pos.*] = ',';
                    pos.* += 1;
                }
                sp.second.serializeImpl(buf, pos);
                if (pos.* + 1 <= buf.len) {
                    buf[pos.*] = ')';
                    pos.* += 1;
                }
            },
        }
    }

    /// Count the total number of leaves in the tree.
    pub fn countLeaves(self: *SplitNode) usize {
        switch (self.*) {
            .leaf => return 1,
            .split => |s| {
                return s.first.countLeaves() + s.second.countLeaves();
            },
        }
    }
};

/// Result of parsing a split tree structure (without creating terminal views).
pub const ParseResult = struct {
    /// The root node of the tree. Leaves have sequential indices starting from 0.
    root: *SplitNode,
    /// Number of leaves in the tree (so caller knows how many terminals to create).
    leaf_count: usize,
};

/// Parse a serialized split tree structure, assigning sequential leaf indices.
/// Returns a tree where leaf values are 0, 1, 2, ... in parse order.
/// The caller is responsible for mapping these indices to actual terminal slots.
pub fn parseStructure(allocator: std.mem.Allocator, input: []const u8) ?ParseResult {
    var pos: usize = 0;
    var leaf_index: usize = 0;
    const root = parseNode(allocator, input, &pos, &leaf_index) orelse return null;
    return .{ .root = root, .leaf_count = leaf_index };
}

fn parseNode(allocator: std.mem.Allocator, input: []const u8, pos: *usize, leaf_index: *usize) ?*SplitNode {
    if (pos.* >= input.len) return null;

    // Check for "leaf"
    if (pos.* + 4 <= input.len and std.mem.eql(u8, input[pos.*..][0..4], "leaf")) {
        pos.* += 4;
        const node = allocator.create(SplitNode) catch return null;
        node.* = .{ .leaf = leaf_index.* };
        leaf_index.* += 1;
        return node;
    }

    // Check for "h(" or "v("
    if (pos.* + 2 <= input.len and (input[pos.*] == 'h' or input[pos.*] == 'v') and input[pos.* + 1] == '(') {
        const direction: SplitDirection = if (input[pos.*] == 'h') .horizontal else .vertical;
        pos.* += 2;

        const first = parseNode(allocator, input, pos, leaf_index) orelse return null;
        if (pos.* < input.len and input[pos.*] == ',') pos.* += 1;
        const second = parseNode(allocator, input, pos, leaf_index) orelse return null;
        if (pos.* < input.len and input[pos.*] == ')') pos.* += 1;

        const node = allocator.create(SplitNode) catch return null;
        node.* = .{ .split = .{
            .direction = direction,
            .first = first,
            .second = second,
            .ratio = 0.5,
        } };
        return node;
    }

    return null;
}

/// Create a single-leaf tree with the given slot index.
pub fn createLeaf(allocator: std.mem.Allocator, slot: usize) ?*SplitNode {
    const node = allocator.create(SplitNode) catch return null;
    node.* = .{ .leaf = slot };
    return node;
}

/// Create a split node with two children.
pub fn createSplit(
    allocator: std.mem.Allocator,
    direction: SplitDirection,
    first: *SplitNode,
    second: *SplitNode,
    ratio: f64,
) ?*SplitNode {
    const node = allocator.create(SplitNode) catch return null;
    node.* = .{ .split = .{
        .direction = direction,
        .first = first,
        .second = second,
        .ratio = ratio,
    } };
    return node;
}

// ============================================================================
// Tests
// ============================================================================

test "serialize leaf" {
    const allocator = std.testing.allocator;
    const node = createLeaf(allocator, 0).?;
    defer allocator.destroy(node);

    var buf: [64]u8 = undefined;
    const result = node.serialize(&buf);
    try std.testing.expectEqualStrings("leaf", result);
}

test "serialize horizontal split" {
    const allocator = std.testing.allocator;
    const left = createLeaf(allocator, 0).?;
    const right = createLeaf(allocator, 1).?;
    const root = createSplit(allocator, .horizontal, left, right, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    var buf: [64]u8 = undefined;
    const result = root.serialize(&buf);
    try std.testing.expectEqualStrings("h(leaf,leaf)", result);
}

test "serialize nested split" {
    const allocator = std.testing.allocator;
    const a = createLeaf(allocator, 0).?;
    const b = createLeaf(allocator, 1).?;
    const c = createLeaf(allocator, 2).?;
    const inner = createSplit(allocator, .horizontal, a, b, 0.5).?;
    const root = createSplit(allocator, .vertical, inner, c, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    var buf: [64]u8 = undefined;
    const result = root.serialize(&buf);
    try std.testing.expectEqualStrings("v(h(leaf,leaf),leaf)", result);
}

test "parse leaf" {
    const allocator = std.testing.allocator;
    const result = parseStructure(allocator, "leaf").?;
    defer allocator.destroy(result.root); // runs LAST
    defer result.root.destroyTree(allocator); // runs FIRST

    try std.testing.expectEqual(@as(usize, 1), result.leaf_count);
    try std.testing.expectEqual(@as(usize, 0), result.root.leaf);
}

test "parse horizontal split" {
    const allocator = std.testing.allocator;
    const result = parseStructure(allocator, "h(leaf,leaf)").?;
    defer allocator.destroy(result.root); // runs LAST
    defer result.root.destroyTree(allocator); // runs FIRST

    try std.testing.expectEqual(@as(usize, 2), result.leaf_count);
    try std.testing.expectEqual(SplitDirection.horizontal, result.root.split.direction);
    try std.testing.expectEqual(@as(usize, 0), result.root.split.first.leaf);
    try std.testing.expectEqual(@as(usize, 1), result.root.split.second.leaf);
}

test "serialize-parse round trip" {
    const allocator = std.testing.allocator;

    // Create a complex tree
    const a = createLeaf(allocator, 0).?;
    const b = createLeaf(allocator, 1).?;
    const c = createLeaf(allocator, 2).?;
    const d = createLeaf(allocator, 3).?;
    const left = createSplit(allocator, .horizontal, a, b, 0.5).?;
    const right = createSplit(allocator, .vertical, c, d, 0.5).?;
    const root = createSplit(allocator, .horizontal, left, right, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    // Serialize
    var buf: [128]u8 = undefined;
    const serialized = root.serialize(&buf);
    try std.testing.expectEqualStrings("h(h(leaf,leaf),v(leaf,leaf))", serialized);

    // Parse back
    const parsed = parseStructure(allocator, serialized).?;
    defer allocator.destroy(parsed.root); // runs LAST
    defer parsed.root.destroyTree(allocator); // runs FIRST

    // Re-serialize and compare
    var buf2: [128]u8 = undefined;
    const reserialized = parsed.root.serialize(&buf2);
    try std.testing.expectEqualStrings(serialized, reserialized);
    try std.testing.expectEqual(@as(usize, 4), parsed.leaf_count);
}

test "countLeaves" {
    const allocator = std.testing.allocator;
    const a = createLeaf(allocator, 0).?;
    const b = createLeaf(allocator, 1).?;
    const c = createLeaf(allocator, 2).?;
    const inner = createSplit(allocator, .horizontal, a, b, 0.5).?;
    const root = createSplit(allocator, .vertical, inner, c, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    try std.testing.expectEqual(@as(usize, 3), root.countLeaves());
}

test "rebalanceAxis horizontal" {
    const allocator = std.testing.allocator;
    // Create h(h(leaf,leaf),leaf) - 3 leaves horizontally
    const a = createLeaf(allocator, 0).?;
    const b = createLeaf(allocator, 1).?;
    const c = createLeaf(allocator, 2).?;
    const inner = createSplit(allocator, .horizontal, a, b, 0.5).?;
    const root = createSplit(allocator, .horizontal, inner, c, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    root.rebalanceAxis(.horizontal);

    // Root should be 2/3 for left (2 leaves) and 1/3 for right (1 leaf)
    try std.testing.expectApproxEqAbs(@as(f64, 2.0 / 3.0), root.split.ratio, 0.001);
    // Inner should be 0.5 (1 leaf each)
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), inner.split.ratio, 0.001);
}

test "findLeaf" {
    const allocator = std.testing.allocator;
    const a = createLeaf(allocator, 42).?;
    const b = createLeaf(allocator, 99).?;
    const root = createSplit(allocator, .horizontal, a, b, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    const found = root.findLeaf(42);
    try std.testing.expect(found != null);
    try std.testing.expectEqual(@as(usize, 42), found.?.leaf);

    const not_found = root.findLeaf(100);
    try std.testing.expect(not_found == null);
}

test "findParent" {
    const allocator = std.testing.allocator;
    const a = createLeaf(allocator, 0).?;
    const b = createLeaf(allocator, 1).?;
    const root = createSplit(allocator, .horizontal, a, b, 0.5).?;
    defer root.destroyTree(allocator);
    defer allocator.destroy(root);

    const parent_of_a = root.findParent(a);
    try std.testing.expect(parent_of_a != null);
    try std.testing.expectEqual(root, parent_of_a.?);

    const parent_of_root = root.findParent(root);
    try std.testing.expect(parent_of_root == null);
}
