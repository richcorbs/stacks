# ObjC Runtime Patterns

All AppKit interaction goes through `src/objc.zig` — a thin wrapper around `objc/runtime.h` and `objc/message.h`.

## Core Pattern: `objc_msgSend` Casting

Every ObjC method call requires casting `objc_msgSend` to the correct function signature:

```zig
// void method with one CGFloat arg
const setAlpha: *const fn (objc.id, objc.SEL, objc.CGFloat) callconv(.c) void =
    @ptrCast(&objc.c.objc_msgSend);
setAlpha(view, objc.sel("setAlphaValue:"), 0.5);
```

Convenience wrappers exist for common patterns:
- `msgSend(target, sel)` → returns `id`
- `msgSendVoid(target, sel)` → returns void
- `msgSendVoid1(target, sel, arg)` → one arg, void return
- `msgSend1(target, sel, arg)` → one arg, returns `id`
- `msgSendRect(target, sel)` → returns `NSRect` (important: uses `objc_msgSend` not `objc_msgSend_stret` on ARM64)
- `nsString([]const u8)` → creates `NSString` (copies into stack buffer, max 4096 bytes)

## Registering Custom Classes

To subclass NSView or NSObject:

```zig
const cls = objc.allocateClassPair(NSView, "UniqueClassName") orelse return null;
_ = objc.addMethod(cls, objc.sel("drawRect:"), &myDrawRect, "v@:{CGRect=dddd}");
_ = objc.addMethod(cls, objc.sel("mouseDown:"), &myMouseDown, "v@:@");
_ = objc.addIvar(cls, "_myData", @sizeOf(usize), @alignOf(usize), "Q");
objc.registerClassPair(cls);
```

**Class names are globally unique per process.** If you change a class's structure, you MUST use a new name. Cache the class in a `var` to avoid re-registration:

```zig
var my_class: ?objc.id = null;
fn registerMyClass() ?objc.id {
    if (my_class) |cls| return cls;
    // ... allocate, add methods, register ...
    my_class = cls;
    return cls;
}
```

## Storing Data on Custom Views

`setTag:` only works on `NSControl` subclasses. For plain `NSView` subclasses, use ivars:

```zig
// Add ivar during class registration (before registerClassPair)
_ = objc.addIvar(cls, "_index", @sizeOf(usize), @alignOf(usize), "Q");

// Set value
const ivar = objc.c.class_getInstanceVariable(objc.c.object_getClass(@ptrCast(@alignCast(view))), "_index");
const offset = objc.c.ivar_getOffset(ivar.?);
const ptr: *usize = @ptrFromInt(@intFromPtr(view) +% @as(usize, @bitCast(@as(isize, offset))));
ptr.* = 42;
```

## ObjC Callback Signatures

Method type encoding strings:
- `"v@:@"` — `void method(id self, SEL _cmd, id arg)`
- `"v@:{CGRect=dddd}"` — void method with NSRect arg
- `"B@:@"` — BOOL method with one id arg
- `"@@:"` — id method with no args

## Common Gotchas

- `objc.nil` is Zig `null` — checking `== objc.nil` works, but `orelse unreachable` on it panics
- `NSView` does not have `setTag:`/`tag` — sending these messages hangs or crashes
- `makeKeyAndOrderFront:` takes a nullable sender — pass `null` not `objc.nil`
- Struct returns (NSRect, NSSize) on ARM64 use regular `objc_msgSend`, not `objc_msgSend_stret`
- Auto Layout constraints use `NSLayoutConstraint` with format strings via `constraintsWithVisualFormat:options:metrics:views:`
