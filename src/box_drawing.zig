/// Box drawing character rendering — lookup tables for Unicode box characters.
///
/// This module provides information about box drawing characters (U+2500-U+257F)
/// to enable pixel-perfect rendering without font support.
const std = @import("std");

/// Connection information for a box drawing character.
pub const BoxInfo = struct {
    left: bool,
    right: bool,
    up: bool,
    down: bool,
    heavy: bool, // thick line (double or heavy)
};

/// Get box drawing connection info for a Unicode character.
/// Returns null if the character is not a box drawing character.
pub fn getInfo(ch: u32) ?BoxInfo {
    if (ch < 0x2500 or ch > 0x257F) return null;

    return switch (ch) {
        // Light lines
        0x2500 => .{ .left = true,  .right = true,  .up = false, .down = false, .heavy = false }, // ─
        0x2502 => .{ .left = false, .right = false, .up = true,  .down = true,  .heavy = false }, // │
        0x250C => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = false }, // ┌
        0x2510 => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = false }, // ┐
        0x2514 => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = false }, // └
        0x2518 => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = false }, // ┘
        0x251C => .{ .left = false, .right = true,  .up = true,  .down = true,  .heavy = false }, // ├
        0x2524 => .{ .left = true,  .right = false, .up = true,  .down = true,  .heavy = false }, // ┤
        0x252C => .{ .left = true,  .right = true,  .up = false, .down = true,  .heavy = false }, // ┬
        0x2534 => .{ .left = true,  .right = true,  .up = true,  .down = false, .heavy = false }, // ┴
        0x253C => .{ .left = true,  .right = true,  .up = true,  .down = true,  .heavy = false }, // ┼
        // Heavy lines
        0x2501 => .{ .left = true,  .right = true,  .up = false, .down = false, .heavy = true },  // ━
        0x2503 => .{ .left = false, .right = false, .up = true,  .down = true,  .heavy = true },  // ┃
        0x250F => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = true },  // ┏
        0x2513 => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = true },  // ┓
        0x2517 => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = true },  // ┗
        0x251B => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = true },  // ┛
        0x2523 => .{ .left = false, .right = true,  .up = true,  .down = true,  .heavy = true },  // ┣
        0x252B => .{ .left = true,  .right = false, .up = true,  .down = true,  .heavy = true },  // ┫
        0x2533 => .{ .left = true,  .right = true,  .up = false, .down = true,  .heavy = true },  // ┳
        0x253B => .{ .left = true,  .right = true,  .up = true,  .down = false, .heavy = true },  // ┻
        0x254B => .{ .left = true,  .right = true,  .up = true,  .down = true,  .heavy = true },  // ╋
        // Rounded corners
        0x256D => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = false }, // ╭
        0x256E => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = false }, // ╮
        0x256F => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = false }, // ╯
        0x2570 => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = false }, // ╰
        // Double lines (treat as heavy)
        0x2550 => .{ .left = true,  .right = true,  .up = false, .down = false, .heavy = true },  // ═
        0x2551 => .{ .left = false, .right = false, .up = true,  .down = true,  .heavy = true },  // ║
        0x2552 => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = true },  // ╒
        0x2553 => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = true },  // ╓
        0x2554 => .{ .left = false, .right = true,  .up = false, .down = true,  .heavy = true },  // ╔
        0x2555 => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = true },  // ╕
        0x2556 => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = true },  // ╖
        0x2557 => .{ .left = true,  .right = false, .up = false, .down = true,  .heavy = true },  // ╗
        0x2558 => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = true },  // ╘
        0x2559 => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = true },  // ╙
        0x255A => .{ .left = false, .right = true,  .up = true,  .down = false, .heavy = true },  // ╚
        0x255B => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = true },  // ╛
        0x255C => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = true },  // ╜
        0x255D => .{ .left = true,  .right = false, .up = true,  .down = false, .heavy = true },  // ╝
        0x255E => .{ .left = false, .right = true,  .up = true,  .down = true,  .heavy = true },  // ╞
        0x255F => .{ .left = false, .right = true,  .up = true,  .down = true,  .heavy = true },  // ╟
        0x2560 => .{ .left = false, .right = true,  .up = true,  .down = true,  .heavy = true },  // ╠
        0x2561 => .{ .left = true,  .right = false, .up = true,  .down = true,  .heavy = true },  // ╡
        0x2562 => .{ .left = true,  .right = false, .up = true,  .down = true,  .heavy = true },  // ╢
        0x2563 => .{ .left = true,  .right = false, .up = true,  .down = true,  .heavy = true },  // ╣
        0x2564 => .{ .left = true,  .right = true,  .up = false, .down = true,  .heavy = true },  // ╤
        0x2565 => .{ .left = true,  .right = true,  .up = false, .down = true,  .heavy = true },  // ╥
        0x2566 => .{ .left = true,  .right = true,  .up = false, .down = true,  .heavy = true },  // ╦
        0x2567 => .{ .left = true,  .right = true,  .up = true,  .down = false, .heavy = true },  // ╧
        0x2568 => .{ .left = true,  .right = true,  .up = true,  .down = false, .heavy = true },  // ╨
        0x2569 => .{ .left = true,  .right = true,  .up = true,  .down = false, .heavy = true },  // ╩
        0x256A => .{ .left = true,  .right = true,  .up = true,  .down = true,  .heavy = true },  // ╪
        0x256B => .{ .left = true,  .right = true,  .up = true,  .down = true,  .heavy = true },  // ╫
        0x256C => .{ .left = true,  .right = true,  .up = true,  .down = true,  .heavy = true },  // ╬
        else => null,
    };
}

/// Check if a character is a box drawing character.
pub fn isBoxDrawing(ch: u32) bool {
    return ch >= 0x2500 and ch <= 0x257F and getInfo(ch) != null;
}

// ============================================================================
// Tests
// ============================================================================

test "light horizontal line" {
    const info = getInfo(0x2500).?; // ─
    try std.testing.expect(info.left);
    try std.testing.expect(info.right);
    try std.testing.expect(!info.up);
    try std.testing.expect(!info.down);
    try std.testing.expect(!info.heavy);
}

test "heavy vertical line" {
    const info = getInfo(0x2503).?; // ┃
    try std.testing.expect(!info.left);
    try std.testing.expect(!info.right);
    try std.testing.expect(info.up);
    try std.testing.expect(info.down);
    try std.testing.expect(info.heavy);
}

test "corner characters" {
    const top_left = getInfo(0x250C).?; // ┌
    try std.testing.expect(!top_left.left);
    try std.testing.expect(top_left.right);
    try std.testing.expect(!top_left.up);
    try std.testing.expect(top_left.down);

    const bottom_right = getInfo(0x2518).?; // ┘
    try std.testing.expect(bottom_right.left);
    try std.testing.expect(!bottom_right.right);
    try std.testing.expect(bottom_right.up);
    try std.testing.expect(!bottom_right.down);
}

test "cross character" {
    const cross = getInfo(0x253C).?; // ┼
    try std.testing.expect(cross.left);
    try std.testing.expect(cross.right);
    try std.testing.expect(cross.up);
    try std.testing.expect(cross.down);
    try std.testing.expect(!cross.heavy);
}

test "non-box characters return null" {
    try std.testing.expect(getInfo('A') == null);
    try std.testing.expect(getInfo(0x2600) == null); // ☀ sun symbol
    try std.testing.expect(getInfo(0) == null);
}

test "isBoxDrawing" {
    try std.testing.expect(isBoxDrawing(0x2500)); // ─
    try std.testing.expect(isBoxDrawing(0x254B)); // ╋
    try std.testing.expect(!isBoxDrawing('A'));
    try std.testing.expect(!isBoxDrawing(0x2580)); // ▀ block element, not box drawing
}
