/// Scrollback buffer — ring buffer for terminal history lines.
///
/// Stores lines that have scrolled off the top of the terminal.
/// Uses a ring buffer to avoid O(n) shifts when the buffer is full.
const std = @import("std");
const vt = @import("vt.zig");

/// A single line of scrollback history.
pub const ScrollLine = struct {
    cells: []vt.Cell,
    len: u16, // original line length (for proper wrapping)

    pub fn deinit(self: *ScrollLine, alloc: std.mem.Allocator) void {
        alloc.free(self.cells);
    }
};

/// Ring buffer for scrollback lines.
/// Avoids O(n) shifts by using head/count pointers.
pub fn ScrollList(comptime max_capacity: usize) type {
    return struct {
        buffer: []ScrollLine = &.{},
        head: usize = 0, // index of first (oldest) element
        count: usize = 0, // number of elements stored
        capacity: usize = 0,

        const Self = @This();
        const INITIAL_CAPACITY = 64;
        const MAX_CAPACITY = max_capacity;

        /// Grow the buffer to at least `cap` elements.
        pub fn initCapacity(self: *Self, alloc: std.mem.Allocator, cap: usize) void {
            if (self.capacity >= cap) return;
            const new_buf = alloc.alloc(ScrollLine, cap) catch return;
            // Copy existing elements in order
            for (0..self.count) |i| {
                new_buf[i] = self.buffer[(self.head + i) % self.capacity];
            }
            if (self.capacity > 0) alloc.free(self.buffer);
            self.buffer = new_buf;
            self.head = 0;
            self.capacity = cap;
        }

        /// Append a line to the buffer. If full, overwrites the oldest line.
        pub fn append(self: *Self, alloc: std.mem.Allocator, line: ScrollLine) void {
            // Lazy growth: start small, double until max
            if (self.count == self.capacity) {
                if (self.capacity < MAX_CAPACITY) {
                    const initial = @min(INITIAL_CAPACITY, MAX_CAPACITY);
                    const new_cap = if (self.capacity == 0)
                        initial
                    else
                        @min(self.capacity * 2, MAX_CAPACITY);
                    self.initCapacity(alloc, new_cap);
                }
            }

            if (self.count < self.capacity) {
                // Space available
                self.buffer[(self.head + self.count) % self.capacity] = line;
                self.count += 1;
            } else {
                // Full at max capacity — overwrite oldest, free its cells
                self.buffer[self.head].deinit(alloc);
                self.buffer[self.head] = line;
                self.head = (self.head + 1) % self.capacity;
            }
        }

        /// Get a line by index (0 = oldest).
        pub fn get(self: *const Self, index: usize) *ScrollLine {
            return &self.buffer[(self.head + index) % self.capacity];
        }

        /// Number of lines in the buffer.
        pub fn len(self: *const Self) usize {
            return self.count;
        }

        /// Clear all lines but keep the allocated buffer.
        pub fn clearRetainingCapacity(self: *Self, alloc: std.mem.Allocator) void {
            for (0..self.count) |i| {
                self.buffer[(self.head + i) % self.capacity].deinit(alloc);
            }
            self.count = 0;
            self.head = 0;
        }

        /// Free all resources.
        pub fn deinit(self: *Self, alloc: std.mem.Allocator) void {
            for (0..self.count) |i| {
                self.buffer[(self.head + i) % self.capacity].deinit(alloc);
            }
            if (self.capacity > 0) alloc.free(self.buffer);
            self.* = .{};
        }
    };
}

// ============================================================================
// Tests
// ============================================================================

fn makeTestLine(alloc: std.mem.Allocator, char: u32, width: usize) ScrollLine {
    const cells = alloc.alloc(vt.Cell, width) catch unreachable;
    for (cells) |*c| {
        c.* = .{ .chars = .{ char, 0, 0, 0, 0, 0 } };
    }
    return .{ .cells = cells, .len = @intCast(width) };
}

test "append and get" {
    const alloc = std.testing.allocator;
    var list: ScrollList(100) = .{};
    defer list.deinit(alloc);

    list.append(alloc, makeTestLine(alloc, 'A', 10));
    list.append(alloc, makeTestLine(alloc, 'B', 10));
    list.append(alloc, makeTestLine(alloc, 'C', 10));

    try std.testing.expectEqual(@as(usize, 3), list.len());
    try std.testing.expectEqual(@as(u32, 'A'), list.get(0).cells[0].chars[0]);
    try std.testing.expectEqual(@as(u32, 'B'), list.get(1).cells[0].chars[0]);
    try std.testing.expectEqual(@as(u32, 'C'), list.get(2).cells[0].chars[0]);
}

test "ring buffer wrap around" {
    const alloc = std.testing.allocator;
    var list: ScrollList(4) = .{}; // tiny capacity for testing
    defer list.deinit(alloc);

    // Fill buffer
    list.append(alloc, makeTestLine(alloc, 'A', 5));
    list.append(alloc, makeTestLine(alloc, 'B', 5));
    list.append(alloc, makeTestLine(alloc, 'C', 5));
    list.append(alloc, makeTestLine(alloc, 'D', 5));

    try std.testing.expectEqual(@as(usize, 4), list.len());

    // Overflow — 'A' should be evicted
    list.append(alloc, makeTestLine(alloc, 'E', 5));

    try std.testing.expectEqual(@as(usize, 4), list.len());
    try std.testing.expectEqual(@as(u32, 'B'), list.get(0).cells[0].chars[0]);
    try std.testing.expectEqual(@as(u32, 'E'), list.get(3).cells[0].chars[0]);
}

test "clearRetainingCapacity" {
    const alloc = std.testing.allocator;
    var list: ScrollList(100) = .{};
    defer list.deinit(alloc);

    list.append(alloc, makeTestLine(alloc, 'X', 10));
    list.append(alloc, makeTestLine(alloc, 'Y', 10));

    try std.testing.expectEqual(@as(usize, 2), list.len());

    list.clearRetainingCapacity(alloc);

    try std.testing.expectEqual(@as(usize, 0), list.len());
    try std.testing.expect(list.capacity > 0); // capacity retained
}

test "empty list" {
    const alloc = std.testing.allocator;
    var list: ScrollList(100) = .{};
    defer list.deinit(alloc);

    try std.testing.expectEqual(@as(usize, 0), list.len());
}

test "lazy growth" {
    const alloc = std.testing.allocator;
    var list: ScrollList(1000) = .{};
    defer list.deinit(alloc);

    // Should start at 0 capacity
    try std.testing.expectEqual(@as(usize, 0), list.capacity);

    // First append triggers initial allocation
    list.append(alloc, makeTestLine(alloc, 'A', 5));
    try std.testing.expectEqual(@as(usize, 64), list.capacity); // INITIAL_CAPACITY

    // Add more to trigger growth
    for (0..63) |_| {
        list.append(alloc, makeTestLine(alloc, 'X', 5));
    }
    try std.testing.expectEqual(@as(usize, 64), list.len());

    // One more triggers doubling
    list.append(alloc, makeTestLine(alloc, 'Y', 5));
    try std.testing.expectEqual(@as(usize, 128), list.capacity);
}
