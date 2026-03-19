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

A 16ms poll timer (`NSTimer`) drives the read loop. There is no async I/O — the PTY master fd is set to `O_NONBLOCK` and polled each tick.

## Key Data Structures

### Session (`term_text_view.zig`)
Each sidebar terminal entry maps to a `Session`:
```
Session {
    vt: VTerm          — libvterm state (grid, cursor, colors)
    pty: Pty            — master fd + child pid
    split_root: SplitNode — binary tree of panes
    scrollback: [512][]u8 — circular buffer of pushed lines
}
```

### SplitNode (`term_text_view.zig`)
Binary tree for split panes:
```
SplitNode = union {
    leaf: { vt, pty, scrollback_offset, ... }
    split: { direction: .horizontal|.vertical, ratio: 0.0-1.0, left, right }
}
```

### ProjectStore (`project.zig`)
```
ProjectStore {
    projects: ArrayList(Project)
    file_path: "~/Library/Application Support/my-term/projects.json"
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
         → objc.zig (used by all ui/ files)
```

## Build

`build.zig` links:
- libvterm from Homebrew (`-lvterm`, include/lib paths from `/opt/homebrew/Cellar/libvterm/0.3.3/`)
- Apple frameworks: AppKit, CoreText, CoreGraphics, QuartzCore, Foundation

Output: `zig-out/bin/my-term` → copy into `/tmp/MyTerm.app/Contents/MacOS/`
