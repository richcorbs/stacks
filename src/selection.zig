/// Text selection — tracks selected text range in terminal.
///
/// Coordinates can be negative to represent scrollback lines.
const std = @import("std");

/// Represents a text selection in terminal coordinates.
pub const Selection = struct {
    active: bool = false,
    start_col: u16 = 0,
    start_row: i32 = 0, // can be negative for scrollback
    end_col: u16 = 0,
    end_row: i32 = 0,

    /// Return type for ordered selection bounds.
    pub const OrderedBounds = struct {
        r1: i32,
        c1: u16,
        r2: i32,
        c2: u16,
    };

    /// Get selection bounds in order (start <= end).
    pub fn ordered(self: Selection) OrderedBounds {
        if (self.start_row < self.end_row or
            (self.start_row == self.end_row and self.start_col <= self.end_col))
        {
            return .{ .r1 = self.start_row, .c1 = self.start_col, .r2 = self.end_row, .c2 = self.end_col };
        }
        return .{ .r1 = self.end_row, .c1 = self.end_col, .r2 = self.start_row, .c2 = self.start_col };
    }

    /// Check if a cell is within the selection.
    pub fn contains(self: Selection, row: i32, col: u16) bool {
        if (!self.active) return false;
        const s = self.ordered();
        if (row < s.r1 or row > s.r2) return false;
        if (row == s.r1 and row == s.r2) return col >= s.c1 and col <= s.c2;
        if (row == s.r1) return col >= s.c1;
        if (row == s.r2) return col <= s.c2;
        return true;
    }

    /// Start a new selection at the given position.
    pub fn start(self: *Selection, row: i32, col: u16) void {
        self.active = true;
        self.start_row = row;
        self.start_col = col;
        self.end_row = row;
        self.end_col = col;
    }

    /// Extend the selection to the given position.
    pub fn extend(self: *Selection, row: i32, col: u16) void {
        self.end_row = row;
        self.end_col = col;
    }

    /// Clear the selection.
    pub fn clear(self: *Selection) void {
        self.active = false;
    }

    /// Check if the selection spans multiple cells (not just a click).
    pub fn hasContent(self: Selection) bool {
        if (!self.active) return false;
        const s = self.ordered();
        return s.r1 != s.r2 or s.c1 != s.c2;
    }
};

// ============================================================================
// Tests
// ============================================================================

test "inactive selection contains nothing" {
    const sel = Selection{};
    try std.testing.expect(!sel.contains(0, 0));
    try std.testing.expect(!sel.contains(5, 10));
}

test "single cell selection" {
    var sel = Selection{};
    sel.start(5, 10);

    try std.testing.expect(sel.contains(5, 10));
    try std.testing.expect(!sel.contains(5, 9));
    try std.testing.expect(!sel.contains(5, 11));
    try std.testing.expect(!sel.contains(4, 10));
}

test "multi-row selection" {
    var sel = Selection{};
    sel.start(2, 5);
    sel.extend(4, 10);

    // Row 2: columns 5+ are selected
    try std.testing.expect(!sel.contains(2, 4));
    try std.testing.expect(sel.contains(2, 5));
    try std.testing.expect(sel.contains(2, 100));

    // Row 3: all columns selected
    try std.testing.expect(sel.contains(3, 0));
    try std.testing.expect(sel.contains(3, 50));

    // Row 4: columns 0-10 selected
    try std.testing.expect(sel.contains(4, 0));
    try std.testing.expect(sel.contains(4, 10));
    try std.testing.expect(!sel.contains(4, 11));

    // Outside rows
    try std.testing.expect(!sel.contains(1, 5));
    try std.testing.expect(!sel.contains(5, 5));
}

test "reverse selection (end before start)" {
    var sel = Selection{};
    sel.start(10, 20);
    sel.extend(5, 10);

    const bounds = sel.ordered();
    try std.testing.expectEqual(@as(i32, 5), bounds.r1);
    try std.testing.expectEqual(@as(u16, 10), bounds.c1);
    try std.testing.expectEqual(@as(i32, 10), bounds.r2);
    try std.testing.expectEqual(@as(u16, 20), bounds.c2);

    // Should work correctly
    try std.testing.expect(sel.contains(5, 10));
    try std.testing.expect(sel.contains(10, 20));
    try std.testing.expect(sel.contains(7, 0));
}

test "negative row (scrollback)" {
    var sel = Selection{};
    sel.start(-5, 10);
    sel.extend(2, 5);

    try std.testing.expect(sel.contains(-5, 10));
    try std.testing.expect(sel.contains(-3, 0));
    try std.testing.expect(sel.contains(0, 50));
    try std.testing.expect(sel.contains(2, 5));
    try std.testing.expect(!sel.contains(-6, 10));
    try std.testing.expect(!sel.contains(3, 0));
}

test "hasContent" {
    var sel = Selection{};

    // Inactive
    try std.testing.expect(!sel.hasContent());

    // Single point (click, no drag)
    sel.start(5, 10);
    try std.testing.expect(!sel.hasContent());

    // Extended to different cell
    sel.extend(5, 11);
    try std.testing.expect(sel.hasContent());
}

test "clear" {
    var sel = Selection{};
    sel.start(5, 10);
    sel.extend(10, 20);

    try std.testing.expect(sel.active);
    sel.clear();
    try std.testing.expect(!sel.active);
    try std.testing.expect(!sel.contains(5, 10));
}
