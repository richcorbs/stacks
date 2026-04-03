/// Kitty graphics protocol support.
/// Handles APC sequences: \x1b_G<params>;<base64data>\x1b\\
/// Supports: transmit+display (a=T), chunked transfers (m=0/1), delete (a=d), PNG format (f=100).
const std = @import("std");
const objc = @import("objc.zig");

const CG = struct {
    extern "CoreGraphics" fn CGDataProviderCreateWithData(info: ?*anyopaque, data: [*]const u8, size: usize, releaseData: ?*const anyopaque) ?*anyopaque;
    extern "CoreGraphics" fn CGDataProviderRelease(provider: *anyopaque) void;
    extern "CoreGraphics" fn CGImageRelease(image: *anyopaque) void;
    extern "CoreGraphics" fn CGImageGetWidth(image: *anyopaque) usize;
    extern "CoreGraphics" fn CGImageGetHeight(image: *anyopaque) usize;
    extern "CoreGraphics" fn CGContextDrawImage(ctx: *anyopaque, rect: objc.NSRect, image: *anyopaque) void;
    extern "CoreGraphics" fn CGContextSaveGState(ctx: *anyopaque) void;
    extern "CoreGraphics" fn CGContextRestoreGState(ctx: *anyopaque) void;
    extern "CoreGraphics" fn CGContextTranslateCTM(ctx: *anyopaque, tx: f64, ty: f64) void;
    extern "CoreGraphics" fn CGContextScaleCTM(ctx: *anyopaque, sx: f64, sy: f64) void;
};

/// A placed image in the terminal grid.
pub const PlacedImage = struct {
    image: *anyopaque, // CGImage (retained)
    col: u16,
    row: u16, // cursor row when placed
    columns: u16, // display width in cells
    rows: u16, // display height in cells
    image_id: u32,
    scroll_offset: i64, // absolute scroll position when placed (for scrollback tracking)
};

/// Per-terminal image state.
pub const ImageState = struct {
    /// Accumulated base64 data for chunked transfers.
    pending_base64: std.ArrayListUnmanaged(u8) = .{},
    /// Parsed params from the first chunk.
    pending_params: Params = .{},
    /// Whether we're in the middle of a chunked transfer.
    has_pending: bool = false,
    /// Placed images (up to MAX_IMAGES).
    images: [MAX_IMAGES]?PlacedImage = [_]?PlacedImage{null} ** MAX_IMAGES,
    image_count: usize = 0,
    /// Total lines scrolled (incremented by scrollback pushes) — used to track absolute row positions.
    total_scrolled: i64 = 0,

    const MAX_IMAGES = 64;

    pub fn deinit(self: *ImageState) void {
        self.pending_base64.deinit(std.heap.page_allocator);
        self.clearAllImages();
    }

    pub fn clearAllImages(self: *ImageState) void {
        for (&self.images) |*slot| {
            if (slot.*) |img| {
                CG.CGImageRelease(img.image);
                slot.* = null;
            }
        }
        self.image_count = 0;
    }

    /// Delete images by ID.
    pub fn deleteById(self: *ImageState, image_id: u32) void {
        for (&self.images) |*slot| {
            if (slot.*) |img| {
                if (img.image_id == image_id) {
                    CG.CGImageRelease(img.image);
                    slot.* = null;
                    self.image_count -= 1;
                }
            }
        }
    }

    /// Delete all visible images.
    pub fn deleteAllVisible(self: *ImageState) void {
        self.clearAllImages();
    }

    /// Add a placed image. Replaces any existing image at the same row, or with the same ID.
    pub fn addImage(self: *ImageState, img: PlacedImage) void {
        // Replace existing image at same row or with same non-zero ID
        for (&self.images) |*slot| {
            if (slot.*) |existing| {
                const same_id = img.image_id != 0 and existing.image_id == img.image_id;
                const same_row = existing.row == img.row and existing.col == img.col and
                    existing.scroll_offset == img.scroll_offset;
                if (same_id or same_row) {
                    CG.CGImageRelease(existing.image);
                    slot.* = img;
                    return;
                }
            }
        }
        // Find empty slot
        for (&self.images) |*slot| {
            if (slot.* == null) {
                slot.* = img;
                self.image_count += 1;
                return;
            }
        }
        // Full — evict first slot
        if (self.images[0]) |old| {
            CG.CGImageRelease(old.image);
        }
        // Shift everything down
        for (0..MAX_IMAGES - 1) |i| {
            self.images[i] = self.images[i + 1];
        }
        self.images[MAX_IMAGES - 1] = img;
    }
};

/// Result of image placement — used by caller to advance cursor.
pub const ImagePlacement = struct {
    columns: u16,
    rows: u16,
};

/// Parsed Kitty graphics parameters.
pub const Params = struct {
    action: u8 = 'T', // T=transmit+display, d=delete, t=transmit, p=put, q=query
    format: u32 = 0, // 100=PNG, 32=RGBA, 24=RGB
    more: bool = false, // m=1 means more chunks follow
    quiet: u8 = 0, // q=1 or q=2 suppress responses
    columns: u16 = 0, // c=N display columns
    rows: u16 = 0, // r=N display rows
    image_id: u32 = 0, // i=N image ID
    delete_target: u8 = 0, // for a=d: A=all, I=by id, etc.
};

/// Parse "key=value,key=value" params from before the semicolon.
pub fn parseParams(data: []const u8) Params {
    var params = Params{};
    var iter = std.mem.splitScalar(u8, data, ',');
    while (iter.next()) |kv| {
        if (kv.len < 3) continue;
        if (kv[1] != '=') continue;
        const key = kv[0];
        const val = kv[2..];
        switch (key) {
            'a' => {
                if (val.len > 0) params.action = val[0];
            },
            'f' => params.format = std.fmt.parseInt(u32, val, 10) catch 0,
            'm' => params.more = (val.len > 0 and val[0] == '1'),
            'q' => params.quiet = std.fmt.parseInt(u8, val, 10) catch 0,
            'c' => params.columns = std.fmt.parseInt(u16, val, 10) catch 0,
            'r' => params.rows = std.fmt.parseInt(u16, val, 10) catch 0,
            'i' => params.image_id = std.fmt.parseInt(u32, val, 10) catch 0,
            'd' => {
                if (val.len > 0) params.delete_target = val[0];
            },
            else => {},
        }
    }
    return params;
}

/// Handle a complete APC sequence (called when we get initial+final in one, or for continuation chunks).
/// Returns image dimensions if an image was placed, for cursor advancement.
pub fn handleCompleteApc(
    state: *ImageState,
    data: []const u8,
    cursor_col: u16,
    cursor_row: u16,
) ?ImagePlacement {
    // Find the semicolon separating params from data
    const semi_pos = std.mem.indexOfScalar(u8, data, ';');
    const param_str = if (semi_pos) |pos| data[0..pos] else data;
    const base64_data = if (semi_pos) |pos| data[pos + 1 ..] else &[_]u8{};

    const params = parseParams(param_str);

    // Handle delete action
    if (params.action == 'd') {
        if (params.delete_target == 'A' or params.delete_target == 'a') {
            state.deleteAllVisible();
        } else if (params.delete_target == 'I' or params.delete_target == 'i') {
            state.deleteById(params.image_id);
        }
        return null;
    }

    if (params.more) {
        // More chunks coming — accumulate
        if (!state.has_pending) {
            // First chunk
            state.pending_base64.clearRetainingCapacity();
            state.pending_params = params;
            state.has_pending = true;
        }
        state.pending_base64.appendSlice(std.heap.page_allocator, base64_data) catch return null;
        return null;
    } else {
        // Final or only chunk
        if (state.has_pending) {
            // Append final chunk data
            state.pending_base64.appendSlice(std.heap.page_allocator, base64_data) catch return null;
            const all_data = state.pending_base64.items;
            const result = processImage(state, state.pending_params, all_data, cursor_col, cursor_row);
            state.pending_base64.clearRetainingCapacity();
            state.has_pending = false;
            return result;
        } else {
            // Single chunk
            return processImage(state, params, base64_data, cursor_col, cursor_row);
        }
    }
}

/// Decode base64 PNG data and create a placed image.
/// Returns placement info for cursor advancement, or null on failure.
pub fn processImage(
    state: *ImageState,
    params: Params,
    base64_data: []const u8,
    cursor_col: u16,
    cursor_row: u16,
) ?ImagePlacement {
    if (base64_data.len == 0) return null;

    // Decode base64
    const decoded = decodeBase64(base64_data) orelse return null;
    defer std.heap.page_allocator.free(decoded);

    // Create CGImage from PNG data
    const cgimage = createCGImageFromPNG(decoded) orelse return null;

    const columns = if (params.columns > 0) params.columns else blk: {
        // Default to some reasonable width based on image dimensions
        const w = CG.CGImageGetWidth(cgimage);
        break :blk @as(u16, @intCast(@min(w / 8, 80)));
    };
    const rows = if (params.rows > 0) params.rows else blk: {
        const h = CG.CGImageGetHeight(cgimage);
        break :blk @as(u16, @intCast(@min(h / 16, 24)));
    };

    state.addImage(.{
        .image = cgimage,
        .col = cursor_col,
        .row = cursor_row,
        .columns = columns,
        .rows = rows,
        .image_id = params.image_id,
        .scroll_offset = state.total_scrolled,
    });

    return .{ .columns = columns, .rows = rows };
}

/// Decode base64 data into raw bytes.
fn decodeBase64(data: []const u8) ?[]u8 {
    // Filter out whitespace/newlines
    var clean = std.heap.page_allocator.alloc(u8, data.len) catch return null;
    var clean_len: usize = 0;
    for (data) |ch| {
        if (ch != '\n' and ch != '\r' and ch != ' ' and ch != '\t') {
            clean[clean_len] = ch;
            clean_len += 1;
        }
    }

    const decoder = std.base64.standard.Decoder;
    const decoded_len = decoder.calcSizeForSlice(clean[0..clean_len]) catch {
        std.heap.page_allocator.free(clean);
        return null;
    };
    const decoded = std.heap.page_allocator.alloc(u8, decoded_len) catch {
        std.heap.page_allocator.free(clean);
        return null;
    };
    decoder.decode(decoded, clean[0..clean_len]) catch {
        std.heap.page_allocator.free(decoded);
        std.heap.page_allocator.free(clean);
        return null;
    };
    std.heap.page_allocator.free(clean);
    return decoded;
}

/// Create a CGImage from PNG data using NSImage as intermediary.
fn createCGImageFromPNG(png_data: []const u8) ?*anyopaque {
    const NSData = objc.getClass("NSData") orelse return null;
    const NSImage = objc.getClass("NSImage") orelse return null;
    const NSBitmapImageRep = objc.getClass("NSBitmapImageRep") orelse return null;

    // Create NSData from bytes
    const dataWithBytes: *const fn (objc.id, objc.SEL, [*]const u8, usize) callconv(.c) ?objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const nsdata = dataWithBytes(
        NSData,
        objc.sel("dataWithBytes:length:"),
        png_data.ptr,
        png_data.len,
    ) orelse return null;

    // Create NSImage from data
    const alloc_fn: *const fn (objc.id, objc.SEL) callconv(.c) ?objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const initWithData: *const fn (objc.id, objc.SEL, objc.id) callconv(.c) ?objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const img_alloc = alloc_fn(NSImage, objc.sel("alloc")) orelse return null;
    const nsimage = initWithData(img_alloc, objc.sel("initWithData:"), nsdata) orelse return null;

    // Get CGImage via NSBitmapImageRep
    // First get the TIFF representation, then create bitmap rep from it
    const tiffRep: *const fn (objc.id, objc.SEL) callconv(.c) ?objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const tiff_data = tiffRep(nsimage, objc.sel("TIFFRepresentation")) orelse return null;

    const imageRepWithData: *const fn (objc.id, objc.SEL, objc.id) callconv(.c) ?objc.id =
        @ptrCast(&objc.c.objc_msgSend);
    const bitmap_rep = imageRepWithData(NSBitmapImageRep, objc.sel("imageRepWithData:"), tiff_data) orelse return null;

    // Get CGImage from bitmap rep
    const cgImage: *const fn (objc.id, objc.SEL) callconv(.c) ?*anyopaque =
        @ptrCast(&objc.c.objc_msgSend);
    const cg_image = cgImage(bitmap_rep, objc.sel("CGImage")) orelse return null;

    // Retain the CGImage since the NSBitmapImageRep owns it
    const CGImageRetain = struct {
        extern "CoreGraphics" fn CGImageRetain(image: *anyopaque) *anyopaque;
    };
    return CGImageRetain.CGImageRetain(cg_image);
}

/// Draw all visible images for a terminal entry.
/// `cgctx` = CoreGraphics context, `cell_width`/`cell_height` = cell dimensions,
/// `visible_rows` = number of visible rows, `scroll_offset` = current scroll offset,
/// `total_rows` = total rows in the terminal, `view_height` = view height in points.
pub fn drawImages(
    state: *const ImageState,
    cgctx: *anyopaque,
    cell_width: f64,
    cell_height: f64,
    visible_rows: u16,
    scroll_offset: i32,
    total_scrolled: i64,
) void {
    for (state.images) |maybe_img| {
        const img = maybe_img orelse continue;

        // Map image grid row to screen row.
        // The image was placed at grid row img.row when total_scrolled was img.scroll_offset.
        // Lines scrolled since = total_scrolled - img.scroll_offset.
        // Current grid row = img.row - lines_scrolled_since.
        // Screen row = grid_row - scroll_offset (scroll_offset is <= 0).
        const lines_scrolled_since = total_scrolled - img.scroll_offset;
        const grid_row = @as(i64, img.row) - lines_scrolled_since;
        // screen_row = grid_row - scroll_offset, but scroll_offset is negative when scrolled up
        // Text loop: logical_row = screen_row + scroll_offset → grid_row
        // So: screen_row = grid_row - scroll_offset
        const screen_row = grid_row - @as(i64, scroll_offset);

        // Check if any part of the image is visible
        if (screen_row + img.rows <= 0) continue;
        if (screen_row >= visible_rows) continue;

        // Calculate pixel coordinates (y_from_top matches text rendering: screen_row * cell_height)
        const x = @as(f64, @floatFromInt(img.col)) * cell_width;
        const y_from_top = @as(f64, @floatFromInt(screen_row)) * cell_height;
        const w = @as(f64, @floatFromInt(img.columns)) * cell_width;
        const h = @as(f64, @floatFromInt(img.rows)) * cell_height;

        // In our flipped NSView (isFlipped=YES), CGContextDrawImage still draws
        // with the image's origin at the bottom-left of the rect. We need to flip
        // the image vertically so it renders right-side-up.
        CG.CGContextSaveGState(cgctx);
        CG.CGContextTranslateCTM(cgctx, x, y_from_top + h);
        CG.CGContextScaleCTM(cgctx, 1.0, -1.0);
        CG.CGContextDrawImage(cgctx, objc.NSMakeRect(0, 0, w, h), img.image);
        CG.CGContextRestoreGState(cgctx);
    }
}

// ============================================================================
// Tests
// ============================================================================

test "parseParams basic" {
    const p = parseParams("a=T,f=100,q=2,c=80,r=10,i=42");
    try std.testing.expectEqual(@as(u8, 'T'), p.action);
    try std.testing.expectEqual(@as(u32, 100), p.format);
    try std.testing.expectEqual(@as(u8, 2), p.quiet);
    try std.testing.expectEqual(@as(u16, 80), p.columns);
    try std.testing.expectEqual(@as(u16, 10), p.rows);
    try std.testing.expectEqual(@as(u32, 42), p.image_id);
    try std.testing.expect(!p.more);
}

test "parseParams chunked" {
    const p = parseParams("a=T,f=100,m=1");
    try std.testing.expectEqual(@as(u8, 'T'), p.action);
    try std.testing.expect(p.more);
}

test "parseParams delete" {
    const p = parseParams("a=d,d=A");
    try std.testing.expectEqual(@as(u8, 'd'), p.action);
    try std.testing.expectEqual(@as(u8, 'A'), p.delete_target);
}

test "decodeBase64 simple" {
    const decoded = decodeBase64("SGVsbG8=") orelse unreachable;
    defer std.heap.page_allocator.free(decoded);
    try std.testing.expectEqualStrings("Hello", decoded);
}
