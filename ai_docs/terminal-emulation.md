# Terminal Emulation

Two modules work together: `src/vt.zig` (terminal state) and `src/pty.zig` (shell process).

## PTY (`src/pty.zig`)

Uses `forkpty()` to create a pseudo-terminal:

```
Parent process                    Child process
    │                                 │
    │ master_fd ◄──── PTY ────► stdin/stdout/stderr
    │ (O_NONBLOCK)                    │
    │                            execvp(shell)
```

- Master fd is non-blocking — `read()` returns 0 when no data
- Child runs user's `$SHELL` (or `/bin/zsh`), optionally with `-c command`
- `TERM=xterm-256color` is set in child environment
- `resize()` sends `TIOCSWINSZ` ioctl to update terminal dimensions

## libvterm (`src/vt.zig`)

Wraps the Homebrew libvterm C library for full VT100/xterm emulation.

### Why Raw Structs?

Zig's `@cImport` cannot handle C bitfields in `VTermScreenCellAttrs`. Two workarounds:

1. **`RawScreenCell`** (40-byte extern struct) — manually mirrors the C struct layout with attrs packed into a `u32`
2. **`@extern` function pointers** — `vterm_screen_set_callbacks` uses opaque callback types; bypassed with raw extern fn pointer

```zig
pub const RawScreenCell = extern struct {
    chars: [6]u32,  // Unicode codepoints
    width: i32,     // cell width (1 or 2 for wide chars)
    attrs: u32,     // bitfield: bold:1, underline:2, italic:1, blink:1, reverse:1, ...
    fg: u32,        // VTermColor (type byte + RGB)
    bg: u32,
};
```

### Color Decoding

`VTermColor` is 4 bytes: `[type, r, g, b]`. Type byte has flags:
- `VTERM_COLOR_RGB` — use r,g,b directly
- `VTERM_COLOR_DEFAULT_FG/BG` — use default colors

### Scrollback

Implemented via `sb_pushline` / `sb_popline` callbacks registered on the vterm screen. Scrollback lines are stored in a circular buffer (512 lines per pane). The callbacks are set using raw function pointers to bypass the opaque `VTermScreenCallbacks` struct.

### Data Flow

```
PTY.read(buf)           → raw bytes from shell
VTerm.feed(buf)         → libvterm parses escape sequences, updates internal grid
VTerm.getCell(row, col) → read cell: chars, colors, attrs
VTerm.getCursor()       → cursor position
VTerm.read(buf)         → any output libvterm wants to send back (e.g. DA responses)
  → PTY.write(buf)
```

### Resize

When the view bounds change:
```
1. Calculate new cols/rows from pixel dimensions and cell metrics
2. VTerm.resize(rows, cols) — updates libvterm's internal grid
3. PTY.resize(cols, rows)   — sends TIOCSWINSZ to shell
```

## Key Constants

- Default FG: `#cccccc` (204, 204, 204)
- Default BG: `#0f141b` (15, 20, 27)
- Font: Menlo, 13pt default (8-36pt range)
- Poll interval: 16ms (~60fps)

## VTerm Output Flushing

After feeding PTY data into libvterm, the output buffer must be flushed back to the PTY. This handles terminal query responses like DSR (`\x1b[6n` → `\x1b[<row>;<col>R`), device attributes (DA), and other sequences that programs like atuin, starship, and fzf depend on.

```
PTY.read(buf)  → VTerm.feed(buf)  → VTerm.read(out_buf)  → PTY.write(out_buf)
```

## 256-Color Support

`decodeVTermColor` handles three color types:
- **RGB** (`VTERM_COLOR_RGB`): direct r,g,b bytes
- **Indexed** (`VTERM_COLOR_INDEXED`): 256-color palette lookup via `indexedColor()`
  - 0-15: standard ANSI colors
  - 16-231: 6×6×6 color cube
  - 232-255: 24-step grayscale ramp
- **Default** (`VTERM_COLOR_DEFAULT_FG/BG`): fallback to configured defaults

## PTY Exit Detection

`Pty.hasExited()` calls `waitpid` with `WNOHANG` and caches the result in an `exited` bool field. This is important because `waitpid` only returns the exit status once — subsequent calls return 0 after the child is reaped. The cached state ensures `hasExited()` remains true for the lifetime of the `Pty` struct.
