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

pub const Pty = struct {
    master_fd: c_int,
    child_pid: c.pid_t,
    exited: bool = false,

    /// Spawn a shell in a new PTY.
    /// `cwd` = working directory, `command` = optional startup command to run.
    pub fn spawn(cwd: []const u8, command: ?[]const u8) !Pty {
        var master_fd: c_int = undefined;

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

        // Use forkpty from util.h
        const pid = c.forkpty(&master_fd, null, null, null);
        if (pid < 0) return error.ForkFailed;

        if (pid == 0) {
            // Child process
            _ = c.chdir(@ptrCast(&cwd_buf));

            // Set proper terminal type — we now have VT100 emulation via libvterm
            _ = c.setenv("TERM", "xterm-256color", 1);

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
    pub fn close(self: *Pty) void {
        if (self.master_fd >= 0) {
            _ = c.close(self.master_fd);
            self.master_fd = -1;
        }
        if (self.child_pid > 0) {
            _ = c.kill(self.child_pid, c.SIGTERM);
            _ = c.waitpid(self.child_pid, null, c.WNOHANG);
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
