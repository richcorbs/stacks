//! Test-only helper for the visual golden. An unbundled GPUI binary cannot
//! become the active app while Stacks owns the menu bar in this session, so the
//! spike raises its own NSWindow above normal windows. Guarded by SPIKE_ON_TOP
//! and never used in ordinary runs.

#![cfg(target_os = "macos")]

use std::{
    ffi::{CStr, c_char, c_void},
    mem::transmute,
};

type Id = *mut c_void;
type Sel = *const c_void;

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
}

unsafe fn class(name: &CStr) -> Id {
    unsafe { objc_getClass(name.as_ptr()) }
}

unsafe fn sel(name: &CStr) -> Sel {
    unsafe { sel_registerName(name.as_ptr()) }
}

unsafe fn send0(obj: Id, selector: &CStr) -> Id {
    let f: extern "C" fn(Id, Sel) -> Id = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector)) }
}

unsafe fn send_usize(obj: Id, selector: &CStr) -> usize {
    let f: extern "C" fn(Id, Sel) -> usize = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector)) }
}

unsafe fn send_index(obj: Id, selector: &CStr, index: usize) -> Id {
    let f: extern "C" fn(Id, Sel, usize) -> Id = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector), index) }
}

unsafe fn send_void_i64(obj: Id, selector: &CStr, value: i64) {
    let f: extern "C" fn(Id, Sel, i64) = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector), value) }
}

unsafe fn send_void_bool(obj: Id, selector: &CStr, value: bool) {
    let f: extern "C" fn(Id, Sel, bool) = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector), value) }
}

unsafe fn send_void(obj: Id, selector: &CStr) {
    let f: extern "C" fn(Id, Sel) = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector)) }
}

unsafe fn send_void_id(obj: Id, selector: &CStr, arg: Id) {
    let f: extern "C" fn(Id, Sel, Id) = unsafe { transmute(objc_msgSend as *const ()) };
    unsafe { f(obj, sel(selector), arg) }
}

pub fn raise_window() {
    unsafe {
        let app = send0(class(c"NSApplication"), c"sharedApplication");
        send_void_bool(app, c"activateIgnoringOtherApps:", true);
        let windows = send0(app, c"windows");
        let count = send_usize(windows, c"count");
        for index in 0..count {
            let window = send_index(windows, c"objectAtIndex:", index);
            send_void_i64(window, c"setLevel:", 1000);
            send_void(window, c"orderFrontRegardless");
            send_void_id(window, c"makeKeyAndOrderFront:", app);
        }
    }
}

/// Host-mode window visibility. `orderOut:` truly hides the window (unlike
/// `visible = false`, which keeps an empty GPUI window around) and
/// `makeKeyAndOrderFront:` + app activation brings it back with keyboard
/// focus. Only the helper's single window exists, so operating on all of
/// `NSApp.windows` is safe here.
pub fn set_window_visible(visible: bool) {
    unsafe {
        let app = send0(class(c"NSApplication"), c"sharedApplication");
        if visible {
            send_void_bool(app, c"activateIgnoringOtherApps:", true);
        }
        let windows = send0(app, c"windows");
        let count = send_usize(windows, c"count");
        for index in 0..count {
            let window = send_index(windows, c"objectAtIndex:", index);
            if visible {
                send_void_id(window, c"makeKeyAndOrderFront:", app);
                send_void(window, c"orderFrontRegardless");
            } else {
                send_void_id(window, c"orderOut:", app);
            }
        }
    }
}
