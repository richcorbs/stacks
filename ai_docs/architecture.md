# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│  NSApplication run loop                                  │
│  ┌──────────┐  ┌─────────────────────────────────────┐  │
│  │ Sidebar  │  │ Main Panel                          │  │
│  │ (scroll  │  │ ┌─────────────────────────────────┐ │  │
│  │  view)   │  │ │ SplitNode tree                  │ │  │
│  │          │  │ │  ┌──────────┬──────────┐        │ │  │
│  │ Projects │  │ │  │TermGrid  │TermGrid  │        │ │  │
│  │ Terminals│  │ │  │  (PTY+VT)│  (PTY+VT)│        │ │  │
│  │ DnD      │  │ │  └──────────┴──────────┘        │ │  │
│  │          │  │ └─────────────────────────────────┘ │  │
│  └──────────┘  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

```
User keystroke → NSView keyDown → PTY.write() → shell process
Shell output   → PTY.read()    → VTerm.feed() → grid cells updated
Poll timer     → read PTY      → feed vterm   → setNeedsDisplay → drawRect
```

An adaptive poll timer (`NSTimer`) drives the read loop. There is no async I/O — the PTY master fd is set to `O_NONBLOCK` and polled each tick. The timer runs at 16ms (~60fps) when there is active PTY output, then drops to 100ms (~10fps) after 0.5s of idle to reduce CPU usage.

## Key Data Structures

### Session (`terminal_state.zig`)
Each sidebar terminal entry maps to a `Session`:
```
Session {
    root: *SplitNode     — binary tree of panes
    focused_slot: usize  — which terminal pane has focus
    cwd: []const u8      — working directory
    terminal_id: []const u8 — unique ID for persistence
}
```

### TermEntry (`terminal_state.zig`)
Each terminal pane in a split:
```
TermEntry {
    vterm: VTerm        — libvterm state (grid, cursor, colors)
    pty: Pty            — master fd + child pid
    view: objc.id       — NSView for this pane
    scrollback: ScrollList — ring buffer of pushed lines
    selection: Selection — text selection state
}
```

### SplitNode (`split_tree.zig`)
Binary tree for split panes:
```
SplitNode = union {
    leaf: usize  — terminal slot index
    split: { direction: .horizontal|.vertical, ratio: 0.0-1.0, first, second }
}
```

### ProjectStore (`project.zig`)
```
ProjectStore {
    projects: ArrayList(Project)
    file_path: "~/Library/Application Support/stacks/projects.json"
}

Project { id, name, path, terminals: ArrayList(Terminal) }
Terminal { id, name, command?, splits? }  // splits: serialized tree e.g. "h(leaf,leaf)"
```

## Module Dependency Graph

```
main.zig → app.zig → project.zig (data model)
         → ui/window.zig → ui/sidebar.zig
                          → ui/term_text_view.zig → vt.zig (libvterm)
                                                   → pty.zig (fork/PTY)
                                                   → split_tree.zig
                                                   → scrollback.zig
                                                   → selection.zig
                                                   → terminal_state.zig
                                                   → term_keys.zig
                                                   → box_drawing.zig
         → objc.zig (used by all ui/ files)
```

## Extracted Modules (Pure, Testable)

| Module | Purpose | Tests |
|--------|---------|-------|
| `split_tree.zig` | Split pane tree operations, serialization with ratios | 12 |
| `scrollback.zig` | Generic ring buffer for terminal history | 5 |
| `selection.zig` | Text selection state and bounds helpers | 7 |
| `terminal_state.zig` | Type definitions for TermEntry, Session | 5 |
| `term_keys.zig` | macOS key codes → terminal escape sequences | 5 |
| `box_drawing.zig` | Unicode box drawing character lookup | 6 |

## Build

`build.zig` links:
- libvterm from Homebrew (`-lvterm`, include/lib paths from `/opt/homebrew/Cellar/libvterm/0.3.3/`)
- Apple frameworks: AppKit, CoreText, CoreGraphics, QuartzCore, Foundation

Output: `zig-out/bin/my-term` → copy into `/tmp/MyTerm.app/Contents/MacOS/`
