/// Minimal Objective-C runtime bindings for AppKit interop from Zig.
const std = @import("std");

// --- C imports for the ObjC runtime ---
pub const c = @cImport({
    @cInclude("objc/runtime.h");
    @cInclude("objc/message.h");
});

pub const id = *anyopaque;
pub const SEL = c.SEL;
pub const Class = c.Class;
pub const BOOL = bool;
pub const YES: BOOL = true;
pub const NO: BOOL = false;
pub const nil: ?id = null;

pub const NSUInteger = usize;
pub const NSInteger = isize;
pub const CGFloat = f64;

pub const NSRect = extern struct {
    origin: NSPoint,
    size: NSSize,
};

pub const NSPoint = extern struct {
    x: CGFloat,
    y: CGFloat,
};

pub const NSSize = extern struct {
    width: CGFloat,
    height: CGFloat,
};

pub const NSRange = extern struct {
    location: NSUInteger,
    length: NSUInteger,
};

pub fn NSMakeRect(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) NSRect {
    return .{
        .origin = .{ .x = x, .y = y },
        .size = .{ .width = w, .height = h },
    };
}

/// Get an ObjC class by name. Returns the class as an `id` for convenience.
pub fn getClass(name: [*:0]const u8) ?id {
    const cls = c.objc_getClass(name);
    return if (cls) |p| @ptrCast(p) else null;
}

/// Get a selector by name.
pub fn sel(name: [*:0]const u8) SEL {
    return c.sel_registerName(name);
}

/// Send a message with no arguments, returning id.
pub fn msgSend(target: anytype, selector: SEL) id {
    const f: *const fn (@TypeOf(target), SEL) callconv(.c) id = @ptrCast(&c.objc_msgSend);
    return f(target, selector);
}

/// Send a message with no arguments, returning void.
pub fn msgSendVoid(target: anytype, selector: SEL) void {
    const f: *const fn (@TypeOf(target), SEL) callconv(.c) void = @ptrCast(&c.objc_msgSend);
    f(target, selector);
}

/// Send a message with no arguments, returning BOOL.
pub fn msgSendBool(target: anytype, selector: SEL) BOOL {
    const f: *const fn (@TypeOf(target), SEL) callconv(.c) BOOL = @ptrCast(&c.objc_msgSend);
    return f(target, selector);
}

/// Send a message with no arguments, returning NSUInteger.
pub fn msgSendUInt(target: anytype, selector: SEL) NSUInteger {
    const f: *const fn (@TypeOf(target), SEL) callconv(.c) NSUInteger = @ptrCast(&c.objc_msgSend);
    return f(target, selector);
}

/// Send a message with one id argument, returning id.
pub fn msgSend1(target: anytype, selector: SEL, arg: anytype) id {
    const f: *const fn (@TypeOf(target), SEL, @TypeOf(arg)) callconv(.c) id = @ptrCast(&c.objc_msgSend);
    return f(target, selector, arg);
}

/// Send a message with one id argument, returning void.
pub fn msgSendVoid1(target: anytype, selector: SEL, arg: anytype) void {
    const f: *const fn (@TypeOf(target), SEL, @TypeOf(arg)) callconv(.c) void = @ptrCast(&c.objc_msgSend);
    f(target, selector, arg);
}

/// Send a message with two arguments, returning id.
pub fn msgSend2(target: anytype, selector: SEL, a1: anytype, a2: anytype) id {
    const f: *const fn (@TypeOf(target), SEL, @TypeOf(a1), @TypeOf(a2)) callconv(.c) id = @ptrCast(&c.objc_msgSend);
    return f(target, selector, a1, a2);
}

/// Send a message with two arguments, returning void.
pub fn msgSendVoid2(target: anytype, selector: SEL, a1: anytype, a2: anytype) void {
    const f: *const fn (@TypeOf(target), SEL, @TypeOf(a1), @TypeOf(a2)) callconv(.c) void = @ptrCast(&c.objc_msgSend);
    f(target, selector, a1, a2);
}

/// Send a message with three arguments, returning id.
pub fn msgSend3(target: anytype, selector: SEL, a1: anytype, a2: anytype, a3: anytype) id {
    const f: *const fn (@TypeOf(target), SEL, @TypeOf(a1), @TypeOf(a2), @TypeOf(a3)) callconv(.c) id = @ptrCast(&c.objc_msgSend);
    return f(target, selector, a1, a2, a3);
}

/// Send a message that returns an NSRect (uses objc_msgSend_stret on x86_64).
pub fn msgSendRect(target: anytype, selector: SEL) NSRect {
    const f: *const fn (@TypeOf(target), SEL) callconv(.c) NSRect = @ptrCast(&c.objc_msgSend);
    return f(target, selector);
}

/// Create an NSString from a Zig slice.
/// Note: copies the string data into a null-terminated buffer since we use initWithUTF8String:.
pub fn nsString(str: []const u8) id {
    const NSString = getClass("NSString") orelse unreachable;
    // We need a null-terminated copy
    var buf: [4096]u8 = undefined;
    const len = @min(str.len, buf.len - 1);
    @memcpy(buf[0..len], str[0..len]);
    buf[len] = 0;
    const alloc_obj = msgSend(NSString, sel("alloc"));
    return msgSend1(alloc_obj, sel("initWithUTF8String:"), @as([*:0]const u8, @ptrCast(&buf)));
}

/// Allocate a new class pair (subclass).
pub fn allocateClassPair(superclass: id, name: [*:0]const u8) ?id {
    const cls = c.objc_allocateClassPair(@ptrCast(@alignCast(superclass)), name, 0);
    return if (cls) |p| @ptrCast(p) else null;
}

/// Register a class pair.
pub fn registerClassPair(cls: id) void {
    c.objc_registerClassPair(@ptrCast(@alignCast(cls)));
}

/// Add a method to a class.
pub fn addMethod(cls: id, name: SEL, imp: anytype, types: [*:0]const u8) bool {
    return c.class_addMethod(@ptrCast(@alignCast(cls)), name, @ptrCast(imp), types);
}

/// Add an ivar to a class.
pub fn addIvar(cls: id, name: [*:0]const u8, size: usize, alignment: u8, types: [*:0]const u8) bool {
    return c.class_addIvar(@ptrCast(@alignCast(cls)), name, size, alignment, types);
}

/// Get the value of an instance variable.
pub fn getIvar(obj: id, name: [*:0]const u8) ?*anyopaque {
    const ivar = c.class_getInstanceVariable(c.object_getClass(@ptrCast(obj)), name);
    if (ivar == null) return null;
    var out: ?*anyopaque = null;
    _ = c.object_getInstanceVariable(@ptrCast(obj), name, &out);
    return out;
}

/// Set the value of an instance variable.
pub fn setIvar(obj: id, name: [*:0]const u8, value: ?*anyopaque) void {
    _ = c.object_setInstanceVariable(@ptrCast(obj), name, value);
}
