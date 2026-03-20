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

            // /bin/zsh is always available on macOS and sources login profile

            if (cmd_z) |cmd_ptr| {
                // Always use /bin/zsh for reliable launch from Finder/Dock
                // (SHELL env may not be set, and PATH is bare)
                // Login shell sources .zprofile/.zshrc to get full PATH
                var argv = [_][*c]const u8{ "/bin/zsh", "-l", "-c", cmd_ptr, null };
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

    /// Write input to the PTY.
    pub fn write(self: *Pty, data: []const u8) void {
        if (self.master_fd < 0) return;
        _ = c.write(self.master_fd, data.ptr, data.len);
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
        if (self.child_pid < 0) return null;
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

    /// Close the PTY.
    pub fn close(self: *Pty) void {
        _ = c.close(self.master_fd);
        self.master_fd = -1;
        _ = c.kill(self.child_pid, c.SIGTERM);
        _ = c.waitpid(self.child_pid, null, c.WNOHANG);
        self.child_pid = -1;
    }
};
