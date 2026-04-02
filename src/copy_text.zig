/// Pure text extraction from terminal cell grids.
/// Separated from term_text_view.zig for testability.
const std = @import("std");
const vt = @import("vt.zig");

/// Extract text from a grid of cells into a UTF-8 buffer.
/// Returns the number of bytes written.
/// `getCellFn` returns the cell at (row, col).
pub fn extractText(
    buf: []u8,
    start_row: i32,
    start_col: u16,
    end_row: i32,
    end_col: u16,
    total_cols: u16,
    getCellFn: *const fn (i32, u16) vt.Cell,
) usize {
    var text_len: usize = 0;

    var row = start_row;
    while (row <= end_row) : (row += 1) {
        const sc: u16 = if (row == start_row) start_col else 0;
        const ec: u16 = if (row == end_row) end_col else total_cols - 1;

        const row_start = text_len;
        var col = sc;
        while (col <= ec) : (col += 1) {
            const cell = getCellFn(row, col);

            // Skip continuation cells of wide characters.
            // libvterm marks them with chars[0] == 0xFFFFFFFF.
            if (cell.width == 0 or cell.chars[0] == 0xFFFFFFFF) continue;

            const ch = cell.chars[0];
            if (ch > 0 and ch <= 0x10FFFF) {
                // Encode all codepoints in the cell (handles combining chars, ZWJ sequences)
                for (cell.chars) |cp| {
                    if (cp == 0) break;
                    if (cp <= 0x10FFFF) {
                        if (text_len + 4 <= buf.len) {
                            const enc_len = std.unicode.utf8Encode(@intCast(cp), buf[text_len..][0..4]) catch 0;
                            if (enc_len > 0) text_len += enc_len;
                        }
                    }
                }
            } else {
                if (text_len < buf.len) {
                    buf[text_len] = ' ';
                    text_len += 1;
                }
            }
        }

        // Trim trailing spaces from this row
        while (text_len > row_start and buf[text_len - 1] == ' ') {
            text_len -= 1;
        }

        // Add newline between rows (but not after the last)
        if (row < end_row and text_len < buf.len) {
            buf[text_len] = '\n';
            text_len += 1;
        }
    }

    return text_len;
}

// ============================================================================
// Tests
// ============================================================================

fn makeCell(char: u32, width: u8) vt.Cell {
    var c = vt.Cell{};
    c.chars[0] = char;
    c.width = width;
    return c;
}

fn makeCombiningCell(chars_slice: []const u32) vt.Cell {
    var c = vt.Cell{};
    for (chars_slice, 0..) |ch, i| {
        c.chars[i] = ch;
    }
    c.width = 2;
    return c;
}

// --- Simple ASCII ---

var ascii_grid = [3]vt.Cell{
    makeCell('H', 1),
    makeCell('i', 1),
    makeCell('!', 1),
};

fn asciiGetCell(_: i32, col: u16) vt.Cell {
    return if (col < ascii_grid.len) ascii_grid[col] else .{};
}

test "extract simple ASCII" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 2, 3, &asciiGetCell);
    try std.testing.expectEqualStrings("Hi!", buf[0..len]);
}

// --- Wide character with continuation cell ---

var wide_grid = [4]vt.Cell{
    makeCell(0x2B50, 2), // ⭐ width=2
    makeCell(0xFFFFFFFF, 1), // continuation
    makeCell('A', 1),
    makeCell('B', 1),
};

fn wideGetCell(_: i32, col: u16) vt.Cell {
    return if (col < wide_grid.len) wide_grid[col] else .{};
}

test "wide char skips continuation cell" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 3, 4, &wideGetCell);
    try std.testing.expectEqualStrings("⭐AB", buf[0..len]);
}

// --- Adjacent wide characters (no extra spaces) ---

var adjacent_wide_grid = [6]vt.Cell{
    makeCell(0x2B50, 2), // ⭐
    makeCell(0xFFFFFFFF, 1), // cont
    makeCell(0x2705, 2), // ✅
    makeCell(0xFFFFFFFF, 1), // cont
    makeCell(0x1F3A8, 2), // 🎨
    makeCell(0xFFFFFFFF, 1), // cont
};

fn adjacentWideGetCell(_: i32, col: u16) vt.Cell {
    return if (col < adjacent_wide_grid.len) adjacent_wide_grid[col] else .{};
}

test "adjacent wide chars no extra spaces" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 5, 6, &adjacentWideGetCell);
    try std.testing.expectEqualStrings("⭐✅🎨", buf[0..len]);
}

// --- Trailing spaces trimmed ---

var trailing_grid = [5]vt.Cell{
    makeCell('A', 1),
    makeCell('B', 1),
    makeCell(' ', 1),
    makeCell(' ', 1),
    makeCell(' ', 1),
};

fn trailingGetCell(_: i32, col: u16) vt.Cell {
    return if (col < trailing_grid.len) trailing_grid[col] else .{};
}

test "trailing spaces trimmed" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 4, 5, &trailingGetCell);
    try std.testing.expectEqualStrings("AB", buf[0..len]);
}

// --- Multi-row ---

var row0 = [3]vt.Cell{ makeCell('A', 1), makeCell('B', 1), makeCell(' ', 1) };
var row1 = [3]vt.Cell{ makeCell('C', 1), makeCell('D', 1), makeCell(' ', 1) };

fn multiRowGetCell(row: i32, col: u16) vt.Cell {
    const r = if (row == 0) &row0 else &row1;
    return if (col < r.len) r[col] else .{};
}

test "multi-row with newlines" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 1, 2, 3, &multiRowGetCell);
    try std.testing.expectEqualStrings("AB\nCD", buf[0..len]);
}

// --- Combining characters (e.g. flag emoji: regional indicators) ---

var combining_grid = [2]vt.Cell{
    makeCombiningCell(&[_]u32{ 0x1F1FA, 0x1F1F8 }), // 🇺🇸 (U+1F1FA U+1F1F8)
    makeCell(0xFFFFFFFF, 1), // continuation
};

fn combiningGetCell(_: i32, col: u16) vt.Cell {
    return if (col < combining_grid.len) combining_grid[col] else .{};
}

test "combining characters preserved" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 1, 2, &combiningGetCell);
    // Should contain both regional indicator codepoints
    const expected = "🇺🇸";
    try std.testing.expectEqualStrings(expected, buf[0..len]);
}

// --- Empty/NUL cells become spaces (then trimmed if trailing) ---

var mixed_grid = [4]vt.Cell{
    makeCell('A', 1),
    makeCell(0, 1), // NUL → space
    makeCell('B', 1),
    makeCell(0, 1), // trailing NUL → space → trimmed
};

fn mixedGetCell(_: i32, col: u16) vt.Cell {
    return if (col < mixed_grid.len) mixed_grid[col] else .{};
}

test "NUL cells become spaces, trailing trimmed" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 3, 4, &mixedGetCell);
    try std.testing.expectEqualStrings("A B", buf[0..len]);
}

// --- Partial selection within a row ---

test "partial column selection" {
    var buf: [64]u8 = undefined;
    // Select only cols 1-2 of wide_grid: [continuation, 'A'] → should skip cont, get "A"
    const len = extractText(&buf, 0, 1, 0, 2, 4, &wideGetCell);
    try std.testing.expectEqualStrings("A", buf[0..len]);
}

// --- Width-0 cells (alternate continuation marker) ---

var width0_grid = [3]vt.Cell{
    makeCell(0x2B50, 2), // ⭐
    makeCell(0, 0), // width=0 continuation
    makeCell('X', 1),
};

fn width0GetCell(_: i32, col: u16) vt.Cell {
    return if (col < width0_grid.len) width0_grid[col] else .{};
}

test "width-0 continuation cells skipped" {
    var buf: [64]u8 = undefined;
    const len = extractText(&buf, 0, 0, 0, 2, 3, &width0GetCell);
    try std.testing.expectEqualStrings("⭐X", buf[0..len]);
}
