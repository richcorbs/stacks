/// libvterm wrapper — provides a VT100/xterm terminal emulator grid.
const std = @import("std");

pub const c = @cImport({
    @cInclude("vterm.h");
});

// Direct extern for vterm_screen_get_cell — bypasses cImport's broken VTermScreenCell
extern fn vterm_screen_get_cell_raw(screen: *c.VTermScreen, pos: c.VTermPos, cell: *anyopaque) c_int;
comptime {
    // Ensure we can call through the same symbol
    _ = @extern(*const anyopaque, .{ .name = "vterm_screen_get_cell" });
}

extern "vterm" fn vterm_screen_get_cell(screen: *c.VTermScreen, pos: c.VTermPos, cell: *anyopaque) c_int;

// Bypass cImport's broken VTermScreenCallbacks type
pub const vterm_screen_set_callbacks_ptr: *const fn (*c.VTermScreen, *const anyopaque, ?*anyopaque) callconv(.c) void =
    @extern(*const fn (*c.VTermScreen, *const anyopaque, ?*anyopaque) callconv(.c) void, .{ .name = "vterm_screen_set_callbacks" });

pub fn screenSetCallbacks(screen: *c.VTermScreen, callbacks: *const anyopaque, user: ?*anyopaque) void {
    vterm_screen_set_callbacks_ptr(screen, callbacks, user);
}

pub const Color = struct {
    r: u8,
    g: u8,
    b: u8,
};

pub const DEFAULT_FG = Color{ .r = 204, .g = 204, .b = 204 };
pub const DEFAULT_BG = Color{ .r = 15, .g = 20, .b = 27 };

pub const Cell = struct {
    chars: [6]u32 = .{ 0, 0, 0, 0, 0, 0 },
    width: u8 = 1,
    fg: Color = DEFAULT_FG,
    bg: Color = DEFAULT_BG,
    bold: bool = false,
    italic: bool = false,
    underline: bool = false,
    reverse: bool = false,
};

/// Raw VTermScreenCell layout (40 bytes) — defined manually because
/// Zig's cImport can't handle the bitfield in VTermScreenCellAttrs.
pub const RawScreenCell = extern struct {
    chars: [6]u32,      // offset 0, 24 bytes
    width: i32,         // offset 24
    attrs: u32,         // offset 28 (bitfield packed into 4 bytes)
    fg: u32,            // offset 32 (VTermColor = 4 bytes)
    bg: u32,            // offset 36
};

comptime {
    if (@sizeOf(RawScreenCell) != 40) @compileError("RawScreenCell size mismatch");
}

pub fn decodeVTermColor(raw: u32, default: Color) Color {
    const bytes = std.mem.asBytes(&raw);
    const color_type = bytes[0];
    const is_default = (color_type & (c.VTERM_COLOR_DEFAULT_FG | c.VTERM_COLOR_DEFAULT_BG)) != 0;
    if (is_default) return default;

    const is_rgb = (color_type & c.VTERM_COLOR_TYPE_MASK) == c.VTERM_COLOR_RGB;
    if (is_rgb) {
        return .{ .r = bytes[1], .g = bytes[2], .b = bytes[3] };
    }

    const is_indexed = (color_type & c.VTERM_COLOR_TYPE_MASK) == c.VTERM_COLOR_INDEXED;
    if (is_indexed) {
        const idx = bytes[1];
        return indexedColor(idx);
    }

    return default;
}

/// Convert a 256-color index to RGB.
fn indexedColor(idx: u8) Color {
    // Standard 16 ANSI colors
    const ansi16 = [16]Color{
        .{ .r = 0, .g = 0, .b = 0 },       // 0 black
        .{ .r = 187, .g = 0, .b = 0 },     // 1 red
        .{ .r = 0, .g = 187, .b = 0 },     // 2 green
        .{ .r = 187, .g = 187, .b = 0 },   // 3 yellow
        .{ .r = 0, .g = 0, .b = 187 },     // 4 blue
        .{ .r = 187, .g = 0, .b = 187 },   // 5 magenta
        .{ .r = 0, .g = 187, .b = 187 },   // 6 cyan
        .{ .r = 187, .g = 187, .b = 187 }, // 7 white
        .{ .r = 85, .g = 85, .b = 85 },    // 8 bright black
        .{ .r = 255, .g = 85, .b = 85 },   // 9 bright red
        .{ .r = 85, .g = 255, .b = 85 },   // 10 bright green
        .{ .r = 255, .g = 255, .b = 85 },  // 11 bright yellow
        .{ .r = 85, .g = 85, .b = 255 },   // 12 bright blue
        .{ .r = 255, .g = 85, .b = 255 },  // 13 bright magenta
        .{ .r = 85, .g = 255, .b = 255 },  // 14 bright cyan
        .{ .r = 255, .g = 255, .b = 255 }, // 15 bright white
    };
    if (idx < 16) return ansi16[idx];

    // 216 color cube: indices 16-231
    if (idx < 232) {
        const ci = idx - 16;
        const b_idx: u8 = ci % 6;
        const g_idx: u8 = (ci / 6) % 6;
        const r_idx: u8 = ci / 36;
        const toVal = struct {
            fn f(v: u8) u8 {
                return if (v == 0) 0 else @as(u8, @intCast(@as(u16, v) * 40 + 55));
            }
        }.f;
        return .{ .r = toVal(r_idx), .g = toVal(g_idx), .b = toVal(b_idx) };
    }

    // Grayscale: indices 232-255
    const gray: u8 = @intCast(@as(u16, idx - 232) * 10 + 8);
    return .{ .r = gray, .g = gray, .b = gray };
}

fn decodeAttrs(raw: u32) struct { bold: bool, italic: bool, underline: bool, reverse: bool } {
    // Bitfield layout: bold:1, underline:2, italic:1, blink:1, reverse:1, ...
    return .{
        .bold = (raw & 1) != 0,
        .underline = (raw & 0b110) != 0,
        .italic = (raw & (1 << 3)) != 0,
        .reverse = (raw & (1 << 5)) != 0,
    };
}

pub const VTerm = struct {
    vt: *c.VTerm,
    screen: *c.VTermScreen,
    rows: u16,
    cols: u16,

    pub fn init(rows: u16, cols: u16) !VTerm {
        const vt = c.vterm_new(@intCast(rows), @intCast(cols)) orelse return error.VTermInitFailed;
        c.vterm_set_utf8(vt, 1);

        const screen = c.vterm_obtain_screen(vt) orelse return error.VTermScreenFailed;
        c.vterm_screen_reset(screen, 1);
        c.vterm_screen_enable_altscreen(screen, 1);

        return .{
            .vt = vt,
            .screen = screen,
            .rows = rows,
            .cols = cols,
        };
    }

    pub fn deinit(self: *VTerm) void {
        c.vterm_free(self.vt);
    }

    pub fn feed(self: *VTerm, data: []const u8) void {
        _ = c.vterm_input_write(self.vt, data.ptr, data.len);
    }

    pub fn read(self: *VTerm, buf: []u8) usize {
        return c.vterm_output_read(self.vt, buf.ptr, buf.len);
    }

    pub fn getCell(self: *VTerm, row: u16, col: u16) Cell {
        if (row >= self.rows or col >= self.cols) return Cell{};
        const pos = c.VTermPos{ .row = @intCast(row), .col = @intCast(col) };
        var raw: RawScreenCell = undefined;
        @memset(std.mem.asBytes(&raw), 0);
        _ = vterm_screen_get_cell(self.screen, pos, @ptrCast(&raw));

        const attrs = decodeAttrs(raw.attrs);
        var cell = Cell{
            .width = if (raw.width > 0) @intCast(raw.width) else 1,
            .fg = decodeVTermColor(raw.fg, DEFAULT_FG),
            .bg = decodeVTermColor(raw.bg, DEFAULT_BG),
            .bold = attrs.bold,
            .italic = attrs.italic,
            .underline = attrs.underline,
            .reverse = attrs.reverse,
        };
        for (0..6) |i| {
            cell.chars[i] = raw.chars[i];
        }
        return cell;
    }

    pub fn getCursor(self: *VTerm) struct { row: u16, col: u16 } {
        var pos: c.VTermPos = undefined;
        c.vterm_state_get_cursorpos(c.vterm_obtain_state(self.vt), &pos);
        return .{
            .row = @intCast(@min(@max(pos.row, 0), @as(c_int, self.rows) - 1)),
            .col = @intCast(@min(@max(pos.col, 0), @as(c_int, self.cols) - 1)),
        };
    }

    pub fn resize(self: *VTerm, rows: u16, cols: u16) void {
        self.rows = rows;
        self.cols = cols;
        c.vterm_set_size(self.vt, @intCast(rows), @intCast(cols));
    }

    pub fn keyboardUnichar(self: *VTerm, ch: u32, mod: c.VTermModifier) void {
        c.vterm_keyboard_unichar(self.vt, ch, mod);
    }

    pub fn keyboardKey(self: *VTerm, key: c.VTermKey, mod: c.VTermModifier) void {
        c.vterm_keyboard_key(self.vt, key, mod);
    }
};
