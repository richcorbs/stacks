# agents.md — AI Agent Guide for Stacks

Native macOS terminal emulator built in **Zig 0.15** using the ObjC runtime for AppKit, **libvterm** for terminal emulation, and PTY for shell processes.

## Quick Start

```bash
zig build                                                    # compile
bash scripts/install.sh                                      # deploy
open ~/Applications/Stacks.app                               # run
```

Kill before redeploying: `pkill -9 -f stacks`

## Critical Pitfalls

1. **`objc.nil` is `null`** — never write `objc.nil orelse unreachable` (instant panic)
2. **ObjC class names are globally unique** — if you change a class's methods/ivars, you must use a new name (e.g. `MyView2` → `MyView3`). `allocateClassPair` returns null for duplicate names.
3. **`setTag:` only works on NSControl subclasses** (NSButton, etc.), not NSView — calling it on NSView hangs the app silently
4. **NSButton eats mouse events** — if you need a parent view to receive mouseDown/mouseDragged, use NSTextField labels instead of NSButton
5. **`sed -i` on source files is dangerous** — it can delete lines containing patterns you didn't intend to match. Use the `edit` tool for surgical changes.
6. **No window on launch?** — usually means `appDidFinishLaunching` hit an `unreachable`. Add `std.debug.print` breadcrumbs and run `./zig-out/bin/stacks` directly (not via `open`) to see stderr.
7. **`bufPrint` alias crash** — never `bufPrint` into a buffer that contains a slice you're formatting from. Copy to a temp buffer first.
8. **`vterm_set_size` hangs without output callback** — libvterm's default 4096-byte output buffer fills during resize. Always register `vterm_output_set_callback` so output flushes synchronously to the PTY.
9. **`sbPopLine` must fill the cells buffer** — if you return 1 from `sb_popline` without writing valid `VTermScreenCell` data into the buffer, `vterm_set_size` hangs. Currently we return 0 (no restore) as a workaround.
10. **Menu key equivalents vs `performKeyEquivalent:`** — Use NSMenuItem key equivalents for shortcuts that should work regardless of focus. Only use `performKeyEquivalent:` for shortcuts needing deferred handling (e.g. font size via `pending_font_delta`).

## Architecture

See [ai_docs/architecture.md](ai_docs/architecture.md) for the full system design.

| File | Lines | Purpose |
|------|-------|---------|
| `src/objc.zig` | 163 | ObjC runtime bindings — [ai_docs/objc-patterns.md](ai_docs/objc-patterns.md) |
| `src/vt.zig` | 210 | libvterm wrapper — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/pty.zig` | 141 | PTY/fork management — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/project.zig` | 339 | Project/terminal data model + JSON persistence |
| `src/app.zig` | 37 | Central app state (wraps ProjectStore) |
| `src/ui/window.zig` | 739 | App delegate, window, header bar, menu bar — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/sidebar.zig` | 1595 | Project list, drag-and-drop, navigation — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/term_text_view.zig` | 2163 | Terminal grid rendering, input, selection — [ai_docs/rendering.md](ai_docs/rendering.md) |

## Key Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘T | New terminal in current project |
| ⌘D | Split horizontal |
| ⇧⌘D | Split vertical |
| ⌘W | Close pane |
| ⌘] / ⌘[ | Cycle focus between panes |
| ⌘= / ⌘- / ⌘0 | Font size increase/decrease/reset |
| ⌘⇧] / ⌘⇧[ | Navigate sidebar (highlight only) |
| ⌘Enter | Activate highlighted sidebar item |
| ⌘V | Paste with bracketed paste mode |
| ⌘K | Clear terminal screen and scrollback |
| ⌘O | Add project |
| ⌘Q | Quit |

## Dependencies

- **libvterm** (Homebrew): `/opt/homebrew/Cellar/libvterm/0.3.3/`
- **Frameworks**: AppKit, CoreText, CoreGraphics, QuartzCore, Foundation

## Data

- Projects: `~/Library/Application Support/stacks/projects.json`
- Window frame: persisted via `setFrameAutosaveName:` ("StacksMainWindow")
- App icon: `resources/AppIcon.icns`
