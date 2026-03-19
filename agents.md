# agents.md — AI Agent Guide for my-term-zig

Native macOS terminal emulator built in **Zig 0.15** using the ObjC runtime for AppKit, **libvterm** for terminal emulation, and PTY for shell processes.

## Quick Start

```bash
zig build                                                    # compile
cp zig-out/bin/my-term /tmp/MyTerm.app/Contents/MacOS/my-term  # deploy
open /tmp/MyTerm.app                                         # run
```

Kill before redeploying: `pkill -9 -f my-term`

## Critical Pitfalls

1. **`objc.nil` is `null`** — never write `objc.nil orelse unreachable` (instant panic)
2. **ObjC class names are globally unique** — if you change a class's methods/ivars, you must use a new name (e.g. `MyView2` → `MyView3`). `allocateClassPair` returns null for duplicate names.
3. **`setTag:` only works on NSControl subclasses** (NSButton, etc.), not NSView — calling it on NSView hangs the app silently
4. **NSButton eats mouse events** — if you need a parent view to receive mouseDown/mouseDragged, use NSTextField labels instead of NSButton
5. **`sed -i` on source files is dangerous** — it can delete lines containing patterns you didn't intend to match. Use the `edit` tool for surgical changes.
6. **No window on launch?** — usually means `appDidFinishLaunching` hit an `unreachable`. Add `std.debug.print` breadcrumbs and run `./zig-out/bin/my-term` directly (not via `open`) to see stderr.
7. **`bufPrint` alias crash** — never `bufPrint` into a buffer that contains a slice you're formatting from. Copy to a temp buffer first.

## Architecture

See [ai_docs/architecture.md](ai_docs/architecture.md) for the full system design.

| File | Lines | Purpose |
|------|-------|---------|
| `src/objc.zig` | 166 | ObjC runtime bindings — [ai_docs/objc-patterns.md](ai_docs/objc-patterns.md) |
| `src/vt.zig` | 161 | libvterm wrapper — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/pty.zig` | 118 | PTY/fork management — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/project.zig` | 330 | Project/terminal data model + JSON persistence |
| `src/pty.zig` | 121 | PTY/fork management — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/app.zig` | 37 | Central app state (wraps ProjectStore) |
| `src/ui/window.zig` | 650 | App delegate, window, header bar, menu bar — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/sidebar.zig` | 1463 | Project list, drag-and-drop, navigation — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/term_text_view.zig` | 1854 | Terminal grid rendering, input, selection — [ai_docs/rendering.md](ai_docs/rendering.md) |

## Key Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘T | New terminal in current project |
| ⌘D | Split horizontal |
| ⇧⌘D | Split vertical |
| ⌘W | Close pane |
| ⌘] / ⌘[ | Cycle focus between panes |
| ⌘= / ⌘- | Font size increase/decrease |
| ⌘⇧] / ⌘⇧[ | Navigate sidebar (highlight only) |
| ⌘Enter | Activate highlighted sidebar item |
| ⌘V | Paste with bracketed paste mode |
| ⌘O | Add project |
| ⌘Q | Quit |

## Dependencies

- **libvterm** (Homebrew): `/opt/homebrew/Cellar/libvterm/0.3.3/`
- **Frameworks**: AppKit, CoreText, CoreGraphics, QuartzCore, Foundation

## Data

- Projects: `~/Library/Application Support/my-term/projects.json`
- Window frame: persisted via `setFrameAutosaveName:` ("MyTermMainWindow")
- App icon: `resources/AppIcon.icns`
