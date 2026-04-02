# agents.md — AI Agent Guide for Stacks

Native macOS terminal emulator built in **Zig 0.15** using the ObjC runtime for AppKit, **libvterm** for terminal emulation, and PTY for shell processes.

## Quick Start

```bash
zig build                                                    # compile
bash scripts/install.sh                                      # deploy
open ~/Applications/Stacks.app                               # run
```

Kill before redeploying: `pkill -9 -f stacks`

**NEVER run `install.sh` UNLESS THE USER TELLS YOU TO.** Use `./zig-out/bin/stacks` directly for testing.

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
11. **ObjC blocks can't be created from Zig** — use a `.m` helper file with C-callable wrapper functions. Link it via `exe.addCSourceFile` in build.zig with `-fobjc-arc`.
12. **`AVAudioSession` is iOS-only** — on macOS, use `AVCaptureDevice authorizationStatusForMediaType:` for microphone permission and `AVAudioEngine` for audio capture.
13. **`AVAudioEngine.inputNode` latches the default device at creation** — if the user changes their system default input between recordings, you must create a new `AVAudioEngine` instance to pick it up.
14. **`var x: objc.id = undefined` is UB** — `objc.id` is `*anyopaque` (non-nullable). Use `?objc.id = null` for any ObjC reference that might not be set yet.
15. **`NSTextField` trims trailing spaces** — don't rely on space padding for fixed-width text. Use a monospace approach or separate views instead.
16. **`SFSpeechRecognitionTask cancel` discards pending results** — use `finish` instead of `cancel` if you want the final transcription delivered to the result handler.
17. **`NSMicrophoneUsageDescription` required** — apps using the microphone must include this key (and `NSSpeechRecognitionUsageDescription` for speech) in Info.plist or they'll crash/silently fail on fresh installs.
18. **Visual combining in the renderer is a maintenance surface** — `drawWideChars` in `term_text_view.zig` merges adjacent cells for flag emoji (RI pairs), skin tone modifiers, and ZWJ sequences at render time. This is necessary because programs use `wcwidth()` to track cursor position, so the cell grid must keep individual characters in separate cells. If you find yourself adding more special cases here, that's the signal to revisit whether libvterm should handle it at the cell level instead.
19. **`CoreAudio` framework must be linked separately** — `AudioObjectGetPropertyData` lives in CoreAudio, not in AVFoundation or AppKit. Add `exe.linkFramework("CoreAudio")` in build.zig.

## Architecture

See [ai_docs/architecture.md](ai_docs/architecture.md) for the full system design.

| File | Lines | Purpose |
|------|-------|---------|
| `src/objc.zig` | 163 | ObjC runtime bindings — [ai_docs/objc-patterns.md](ai_docs/objc-patterns.md) |
| `src/vt.zig` | 209 | libvterm wrapper — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/pty.zig` | 155 | PTY/fork management — [ai_docs/terminal-emulation.md](ai_docs/terminal-emulation.md) |
| `src/project.zig` | 345 | Project/terminal data model + JSON persistence |
| `src/app.zig` | 37 | Central app state (wraps ProjectStore) |
| `src/split_tree.zig` | 444 | Split pane tree structure + serialization (12 tests) |
| `src/scrollback.zig` | 194 | Ring buffer for terminal history (5 tests) |
| `src/selection.zig` | 169 | Text selection state + helpers (7 tests) |
| `src/terminal_state.zig` | 301 | Terminal/session type definitions |
| `src/term_keys.zig` | 104 | Key code → escape sequence mapping (5 tests) |
| `src/box_drawing.zig` | 146 | Unicode box drawing character info (6 tests) |
| `src/ui/window.zig` | 789 | App delegate, window, header bar, menu bar — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/sidebar.zig` | 1903 | Project list, drag-and-drop, navigation — [ai_docs/ui-system.md](ai_docs/ui-system.md) |
| `src/ui/term_text_view.zig` | 2280 | Terminal grid rendering, input — [ai_docs/rendering.md](ai_docs/rendering.md) |

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
