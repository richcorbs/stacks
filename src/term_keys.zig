/// Terminal key mapping — converts macOS key codes to terminal escape sequences.
///
/// This module provides pure functions for mapping keyboard input to
/// the escape sequences expected by terminal applications.
const std = @import("std");

/// macOS virtual key codes for special keys.
pub const KeyCode = enum(u16) {
    enter = 36,
    tab = 48,
    backspace = 51,
    escape = 53,
    up = 126,
    down = 125,
    right = 124,
    left = 123,
    delete = 117,
    home = 115,
    end = 119,
    page_up = 116,
    page_down = 121,
    _,

    pub fn from(code: u16) KeyCode {
        return @enumFromInt(code);
    }
};

/// Get the escape sequence for a special key.
/// Returns null for regular character keys.
pub fn getEscapeSequence(code: KeyCode, has_shift: bool) ?[]const u8 {
    return switch (code) {
        .enter => if (has_shift) "\n" else "\r",
        .tab => "\t",
        .backspace => "\x7f",
        .escape => "\x1b",
        .up => "\x1b[A",
        .down => "\x1b[B",
        .right => "\x1b[C",
        .left => "\x1b[D",
        .home => "\x1b[H",
        .end => "\x1b[F",
        .page_up => "\x1b[5~",
        .page_down => "\x1b[6~",
        .delete => "\x1b[3~",
        _ => null,
    };
}

/// Convert a regular character to its ctrl-modified form.
/// For example, 'c' with ctrl becomes \x03 (ETX).
/// Returns null if the character can't be ctrl-modified.
pub fn ctrlModify(char: u8) ?u8 {
    if (char >= 'a' and char <= 'z') {
        return char - 'a' + 1;
    } else if (char >= 'A' and char <= 'Z') {
        return char - 'A' + 1;
    }
    return null;
}

/// Check if a key code is a special key (not a regular character).
pub fn isSpecialKey(code: KeyCode) bool {
    return getEscapeSequence(code, false) != null;
}

// ============================================================================
// Tests
// ============================================================================

test "arrow key sequences" {
    try std.testing.expectEqualStrings("\x1b[A", getEscapeSequence(.up, false).?);
    try std.testing.expectEqualStrings("\x1b[B", getEscapeSequence(.down, false).?);
    try std.testing.expectEqualStrings("\x1b[C", getEscapeSequence(.right, false).?);
    try std.testing.expectEqualStrings("\x1b[D", getEscapeSequence(.left, false).?);
}

test "enter key with shift" {
    try std.testing.expectEqualStrings("\r", getEscapeSequence(.enter, false).?);
    try std.testing.expectEqualStrings("\n", getEscapeSequence(.enter, true).?);
}

test "control characters" {
    try std.testing.expectEqual(@as(u8, 3), ctrlModify('c').?); // Ctrl+C = ETX
    try std.testing.expectEqual(@as(u8, 3), ctrlModify('C').?); // Ctrl+Shift+C
    try std.testing.expectEqual(@as(u8, 1), ctrlModify('a').?); // Ctrl+A = SOH
    try std.testing.expectEqual(@as(u8, 26), ctrlModify('z').?); // Ctrl+Z = SUB
    try std.testing.expect(ctrlModify('1') == null); // Numbers can't be ctrl-modified
}

test "special key detection" {
    try std.testing.expect(isSpecialKey(.enter));
    try std.testing.expect(isSpecialKey(.escape));
    try std.testing.expect(isSpecialKey(.up));
    try std.testing.expect(!isSpecialKey(@enumFromInt(0))); // 'a' key
}

test "navigation keys" {
    try std.testing.expectEqualStrings("\x1b[H", getEscapeSequence(.home, false).?);
    try std.testing.expectEqualStrings("\x1b[F", getEscapeSequence(.end, false).?);
    try std.testing.expectEqualStrings("\x1b[5~", getEscapeSequence(.page_up, false).?);
    try std.testing.expectEqualStrings("\x1b[6~", getEscapeSequence(.page_down, false).?);
    try std.testing.expectEqualStrings("\x1b[3~", getEscapeSequence(.delete, false).?);
}
