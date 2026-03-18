# my-term (Zig + libghostty)

A native macOS project-shell manager built with Zig and [libghostty](https://github.com/ghostty-org/ghostty).

This is a port of the Electron/xterm.js version, replacing:
- **Electron** → native AppKit (via Zig's ObjC interop)
- **xterm.js + node-pty** → libghostty (terminal emulation, PTY, Metal rendering)
- **Node.js** → Zig (git operations, project persistence, session management)

## Features

- **Project management** — Add directories as projects, persisted to `~/Library/Application Support/my-term/projects.json`
- **Multiple terminals per project** — Each with optional startup commands
- **Split panes per tab** — Horizontal and vertical splits (Ghostty-style)
- **Tabs per terminal view** — Multiple tabs within each project terminal
- **Git integration** — Status, staging, commits, push/pull, branches, worktrees, diffs
- **Keyboard-driven** — Full menu shortcuts for splits, tabs, and pane navigation

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘D | Split Right (horizontal) |
| ⇧⌘D | Split Down (vertical) |
| ⇧⌘W | Close Pane |
| ⌘] | Focus Next Pane |
| ⌘[ | Focus Previous Pane |
| ⌘+ | Grow Pane |
| ⌘- | Shrink Pane |
| ⌘T | New Tab |
| ⌘W | Close Tab |
| ⌘} | Next Tab |
| ⌘{ | Previous Tab |
| ⌘O | Add Project |
| ⌘Q | Quit |

## Architecture

```
src/
├── main.zig              Entry point
├── app.zig               Application state (projects + sessions + git)
├── project.zig           Project CRUD & JSON persistence
├── git.zig               Git operations (wraps CLI git)
├── terminal.zig          Split-tree session management
├── ghostty.zig           libghostty C API wrapper
├── objc.zig              Objective-C runtime bindings
└── ui/
    ├── window.zig         Main window, menus, AppKit run loop
    ├── sidebar.zig        Project sidebar (NSOutlineView)
    ├── terminal_view.zig  Terminal host with NSSplitView tree
    └── git_panel.zig      Git status/commit/log panel
```

### Split Tree Model

Each terminal tab holds a **binary split tree** where:
- **Leaf nodes** = individual ghostty surfaces (terminal + PTY + Metal renderer)
- **Interior nodes** = horizontal or vertical splits with adjustable ratios

This mirrors Ghostty's own split model. The tree maps to nested `NSSplitView` instances.

```
Tab "1"
└── Split (horizontal, 50/50)
    ├── Leaf [surface A] ← focused
    └── Split (vertical, 60/40)
        ├── Leaf [surface B]
        └── Leaf [surface C]
```

## Building

### Prerequisites

1. **Zig 0.14+**
2. **libghostty** — Build from the [Ghostty source](https://github.com/ghostty-org/ghostty):
   ```bash
   cd ghostty
   zig build -Doptimize=ReleaseFast
   # This produces include/ and zig-out/lib/libghostty.a (or .dylib)
   ```

### Build & Run

```bash
# Point to your ghostty build output
zig build -Dghostty-path=/path/to/ghostty/zig-out run

# Or if installed to /usr/local/lib/ghostty:
zig build run
```

## Project Data

Projects are stored in `~/Library/Application Support/my-term/projects.json` —
the same format as the Electron version, so you can migrate seamlessly.
