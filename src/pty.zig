/// PTY management — fork a child shell with a pseudo-terminal.
const std = @import("std");

const c = @cImport({
    @cInclude("stdlib.h");
    @cInclude("util.h");
    @cInclude("unistd.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("termios.h");
    @cInclude("signal.h");
    @cInclude("fcntl.h");
});

pub const WinSize = struct { cols: u16 = 80, rows: u16 = 24 };

pub const Pty = struct {
    master_fd: c_int,
    child_pid: c.pid_t,
    exited: bool = false,

    /// Spawn a shell in a new PTY.
    /// `cwd` = working directory, `command` = optional startup command to run.
    pub fn spawn(cwd: []const u8, command: ?[]const u8, size: WinSize) !Pty {
        var master_fd: c_int = undefined;
        var ws: c.struct_winsize = .{
            .ws_col = size.cols,
            .ws_row = size.rows,
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };

        // Make null-terminated copies for C APIs
        var cwd_buf: [4096]u8 = undefined;
        const cwd_len = @min(cwd.len, cwd_buf.len - 1);
        @memcpy(cwd_buf[0..cwd_len], cwd[0..cwd_len]);
        cwd_buf[cwd_len] = 0;

        var cmd_buf: [4096]u8 = undefined;
        var cmd_z: ?[*:0]const u8 = null;
        if (command) |cmd| {
            const cmd_len = @min(cmd.len, cmd_buf.len - 1);
            @memcpy(cmd_buf[0..cmd_len], cmd[0..cmd_len]);
            cmd_buf[cmd_len] = 0;
            cmd_z = @ptrCast(&cmd_buf);
        }

        // Use forkpty from util.h — pass winsize so child starts at correct dimensions
        const pid = c.forkpty(&master_fd, null, null, &ws);
        if (pid < 0) return error.ForkFailed;

        if (pid == 0) {
            // Child process
            _ = c.chdir(@ptrCast(&cwd_buf));

            // Set proper terminal type — we now have VT100 emulation via libvterm
            _ = c.setenv("TERM", "xterm-256color", 1);

            // Advertise Kitty graphics protocol support so TUI apps (e.g. pi) can display images inline
            _ = c.setenv("TERM_PROGRAM", "stacks", 1);
            _ = c.setenv("KITTY_WINDOW_ID", "1", 1);
            _ = c.setenv("COLORTERM", "truecolor", 1);

            // Ensure UTF-8 locale so programs output valid UTF-8.
            // Without this, some tools produce invalid byte sequences.
            _ = c.setenv("LANG", "en_US.UTF-8", 0); // 0 = don't overwrite if already set
            _ = c.setenv("LC_CTYPE", "en_US.UTF-8", 0);

            // /bin/zsh is always available on macOS and sources login profile

            if (cmd_z) |cmd_ptr| {
                // Run command inside an interactive login shell so that
                // .zprofile AND .zshrc are both sourced (full PATH available).
                // We build: /bin/zsh -lic "command"
                var argv = [_][*c]const u8{ "/bin/zsh", "-lic", cmd_ptr, null };
                _ = c.execvp("/bin/zsh", @ptrCast(&argv));
            } else {
                // Interactive login shell
                var argv = [_][*c]const u8{ "/bin/zsh", "-l", null };
                _ = c.execvp("/bin/zsh", @ptrCast(&argv));
            }
            // If exec fails, exit
            c._exit(1);
        }

        // Parent process
        // Set master fd to non-blocking
        const flags = c.fcntl(master_fd, c.F_GETFL);
        _ = c.fcntl(master_fd, c.F_SETFL, flags | c.O_NONBLOCK);

        return .{
            .master_fd = master_fd,
            .child_pid = pid,
        };
    }

    /// Read available output from the PTY. Returns bytes read, 0 if nothing available.
    pub fn read(self: *Pty, buf: []u8) usize {
        if (self.master_fd < 0) return 0;
        const n = c.read(self.master_fd, buf.ptr, buf.len);
        if (n <= 0) return 0;
        return @intCast(n);
    }

    /// Write input to the PTY, handling partial writes and buffer-full conditions.
    pub fn write(self: *Pty, data: []const u8) void {
        if (self.master_fd < 0) return;
        var remaining = data;
        var retries: u32 = 0;
        while (remaining.len > 0 and retries < 100) {
            const n = c.write(self.master_fd, remaining.ptr, remaining.len);
            if (n > 0) {
                remaining = remaining[@intCast(n)..];
                retries = 0;
            } else {
                // EAGAIN/EWOULDBLOCK — brief sleep to let PTY drain
                retries += 1;
                // usleep(1000) = 1ms wait for PTY to drain
                _ = c.usleep(1000);
            }
        }
    }

    /// Resize the PTY.
    pub fn resize(self: *Pty, cols: u16, rows: u16) void {
        var ws: c.winsize = .{
            .ws_col = cols,
            .ws_row = rows,
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(self.master_fd, c.TIOCSWINSZ, &ws);
    }

    /// Check if child has exited.
    pub fn hasExited(self: *Pty) bool {
        if (self.exited) return true;
        if (self.child_pid < 0) { self.exited = true; return true; }
        var status: c_int = 0;
        const result = c.waitpid(self.child_pid, &status, c.WNOHANG);
        if (result > 0) { self.exited = true; return true; }
        return false;
    }

    /// Get the current working directory of the child process.
    pub fn getCwd(self: *Pty, buf: []u8) ?[]const u8 {
        if (self.child_pid < 0 or self.exited) return null;
        const libproc = struct {
            extern "c" fn proc_pidinfo(pid: c.pid_t, flavor: c_int, arg: u64, buffer: *anyopaque, buffersize: c_int) c_int;
        };
        // PROC_PIDVNODEPATHINFO = 9, struct is 2352 bytes
        var vpi: [2352]u8 = undefined;
        const ret = libproc.proc_pidinfo(self.child_pid, 9, 0, &vpi, 2352);
        if (ret <= 0) return null;
        // pvi_cdir.vip_path starts at offset 152 (after pvi_cdir.vip_vi), 1024 bytes
        const path_offset = 152;
        const path_ptr: [*:0]const u8 = @ptrCast(&vpi[path_offset]);
        const path = std.mem.span(path_ptr);
        if (path.len == 0) return null;
        const len = @min(path.len, buf.len);
        @memcpy(buf[0..len], path[0..len]);
        return buf[0..len];
    }

    /// Whether the PTY has been closed (no running process).
    pub fn isClosed(self: *const Pty) bool {
        return self.master_fd < 0;
    }

    /// Close the PTY. Safe to call multiple times.
    ///
    /// We terminate the entire terminal process group, not just the shell PID,
    /// so jobs started inside the shell (e.g. servers) do not survive pane/session
    /// deletion. forkpty creates the child with a controlling terminal and its own
    /// session/process group, so signalling -child_pid targets that terminal job tree.
    pub fn close(self: *Pty) void {
        if (self.master_fd >= 0) {
            _ = c.close(self.master_fd);
            self.master_fd = -1;
        }
        if (self.child_pid > 0) {
            const pgid = -self.child_pid;

            // Ask the whole terminal process group to exit cleanly first.
            _ = c.kill(pgid, c.SIGTERM);

            var status: c_int = 0;
            var exited = false;
            var attempts: usize = 0;
            while (attempts < 50) : (attempts += 1) {
                const result = c.waitpid(self.child_pid, &status, c.WNOHANG);
                if (result > 0) {
                    exited = true;
                    break;
                }
                _ = c.usleep(10_000); // 10ms, up to 500ms total
            }

            // If the shell did not exit, force-kill the whole process group.
            if (!exited) {
                _ = c.kill(pgid, c.SIGKILL);
                attempts = 0;
                while (attempts < 50) : (attempts += 1) {
                    const result = c.waitpid(self.child_pid, &status, c.WNOHANG);
                    if (result > 0) break;
                    _ = c.usleep(10_000); // another 500ms max
                }
            }

            self.child_pid = -1;
        }
        self.exited = true;
    }
};

// ============================================================================
// Tests
// ============================================================================

test "close is idempotent" {
    var pty = Pty{ .master_fd = -1, .child_pid = -1, .exited = true };
    // Calling close on an already-closed PTY should not panic or misbehave
    pty.close();
    pty.close();
    try std.testing.expect(pty.isClosed());
    try std.testing.expect(pty.hasExited());
    try std.testing.expectEqual(@as(c_int, -1), pty.master_fd);
    try std.testing.expectEqual(@as(c.pid_t, -1), pty.child_pid);
}

test "isClosed reflects state" {
    var pty = Pty{ .master_fd = 42, .child_pid = 1234 };
    try std.testing.expect(!pty.isClosed());
    // Simulate close without actually calling kill/close on real fds
    pty.master_fd = -1;
    pty.child_pid = -1;
    pty.exited = true;
    try std.testing.expect(pty.isClosed());
}

test "hasExited with negative pid" {
    var pty = Pty{ .master_fd = -1, .child_pid = -1 };
    try std.testing.expect(pty.hasExited());
    try std.testing.expect(pty.exited);
}

test "read and write on closed PTY are no-ops" {
    var pty = Pty{ .master_fd = -1, .child_pid = -1, .exited = true };
    var buf: [64]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), pty.read(&buf));
    // write should return without hanging
    pty.write("hello");
}

// State transition tests for pane lifecycle:
// These verify the invariants that term_text_view.zig relies on for
// focus borders, confirmation dialogs, and respawn triggers.

test "state transitions: running -> exited -> closed" {
    // Simulates: shell running -> process exits -> exit handler closes PTY
    var pty = Pty{ .master_fd = 42, .child_pid = 1234 };

    // Running: hasExited=false, isClosed=false
    try std.testing.expect(!pty.hasExited());
    try std.testing.expect(!pty.isClosed());

    // Process exits (detected by waitpid in hasExited)
    pty.exited = true;
    // hasExited=true, isClosed=false — transient state before exit handler runs
    try std.testing.expect(pty.hasExited());
    try std.testing.expect(!pty.isClosed());

    // Exit handler calls close()
    pty.master_fd = -1;
    pty.child_pid = -1;
    // hasExited=true, isClosed=true — empty pane state
    try std.testing.expect(pty.hasExited());
    try std.testing.expect(pty.isClosed());
}

test "hasExited and not isClosed means skip confirmation" {
    // This is the state where closeFocusedPane skips the dialog:
    // process just exited but exit handler hasn't run yet.
    var pty = Pty{ .master_fd = 42, .child_pid = 1234 };
    pty.exited = true;
    const skip_confirm = pty.hasExited() and !pty.isClosed();
    try std.testing.expect(skip_confirm);
}

test "isClosed means show confirmation and allow respawn" {
    // This is the empty pane state — closeFocusedPane should confirm,
    // and focus/click should trigger respawnPaneShell.
    var pty = Pty{ .master_fd = -1, .child_pid = -1, .exited = true };
    const show_confirm = !(pty.hasExited() and !pty.isClosed());
    const should_respawn = pty.isClosed();
    try std.testing.expect(show_confirm);
    try std.testing.expect(should_respawn);
}
