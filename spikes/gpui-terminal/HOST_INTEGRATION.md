# Host integration contract

This is the hand-off boundary for the later “convert the rest” GPUI card. The
goal is that the terminal surface can move without redesigning its emulator,
layout, input, or parity harness.

## Reusable modules

The modules below now live in `crates/stacks-terminal` (card #321 extracted them
from the card #318 spike). `spikes/gpui-terminal` and `apps/stacks-gpui` both
depend on that crate, so there is one source of truth.

| Module | Responsibility | Host-owned? |
| --- | --- | --- |
| `crates/stacks-terminal/src/terminal_model.rs` | libghostty-vt lifecycle, frame materialization, selection, search, paste/key/mouse encoding | no |
| `crates/stacks-terminal/src/terminal_surface.rs` | cell metrics, shaped rows, colors, cursor, marked-text painting, `TerminalStyle` | no |
| `crates/stacks-terminal/src/split_tree.rs` | split tree, split/remove/ratio/relative-pane math | no |
| `crates/stacks-terminal/src/pty.rs` | portable-pty spawn/write/resize, login shell, generation ids, async events | no |
| `crates/stacks-terminal/src/keymap.rs` | GPUI keystroke → Ghostty key/modifier mapping | no |
| `crates/stacks-terminal/parity/` | xterm.js differential harness, corpus, known divergences | no |
| `spikes/gpui-terminal/src/app.rs` | demo host: tabs, panes, focus, key routing, chrome, IME, clipboard | yes |
| `apps/stacks-gpui/src/shell.rs` | card #321 shell host: chrome, menu/keybindings, settings/persistence, notifications, drag/drop | yes |

The GPUI shell consumes the library modules and replaces the demo host, not
copies `app.rs` wholesale.

## Terminal invariants to preserve

- `TerminalModel` and every libghostty-vt handle stay on one thread
  (`!Send + !Sync`). Use a foreground task + channel, as `app.rs` and
  `apps/stacks-gpui/src/shell.rs` do.
- PTY events are generation-tagged; stale data/exit events must be discarded.
- PTY output is fed as raw bytes; do not decode chunks independently.
- One `TerminalModel` per pane, one PTY per pane.
- Resize order is: compute cell metrics → resize emulator → resize PTY.
- Plain text on non-IME layouts may go straight to the PTY; IME layouts must use
  GPUI's `EntityInputHandler` marked/commit path.
- Focus reporting (DEC mode 1004) is per pane, not per window.
- Copy-on-select applies Stacks' `/[^\S\r\n]+$/gm` trailing-whitespace trim.
- Paste is LF→CR normalized and uses libghostty-vt's safety filtering (ESC and
  other unsafe controls are replaced with spaces).

## Host services still needed

The future shell must provide these around the reusable modules:

- Window/event loop and one focus handle per pane group.
- Clipboard read/write adapter.
- Settings: font family, font size, scrollback, palette/theme, copy-on-select.
- Persistence: tabs, pane split trees, focused pane, tab titles, cwd.
- Window title updates and bell/notification routing.
- File-drop-to-terminal path insertion.
- Link detection/opening (not implemented in the spike).
- Native menu/keybinding registration; the spike handles shortcuts in `app.rs`.
- Command routing for “new tab”, “split”, “close”, “search”, “clear”,
  “navigate pane/tab”.

## Split behaviour

`split_tree.rs` mirrors Stacks' current semantics:

- `Cmd+D` splits the focused pane side-by-side.
- `Shift+Cmd+D` splits stacked.
- `Cmd+[`/`Cmd+]` cycles tabs; `Shift+Cmd+[`/`]` cycles panes
  (`Option+Cmd+[`/`]` is kept as an alias).
- `Shift+Cmd+Enter` toggles maximize for the focused pane (`Shift+Cmd+M` is kept
  as an alias) so the native window matches Stacks' menu accelerator. While a
  pane is maximized, pane navigation moves the maximized pane to the newly
  focused pane instead of leaving the old pane visible.
- Closing the focused pane selects the previous pane in visual order.
- Closing the last pane closes the tab when another tab exists.
- Manually resized splits keep `manual: true`; the demo does not yet expose a
  drag handle, but the model retains the flag.

## Search behaviour

`TerminalModel::search_set/search_next/search_prev/search_clear` use
libghostty-vt's incremental search, including scrollback. `Cmd+F` opens the
host overlay; Enter/Shift+Enter select next/previous; Escape closes. Search is
synchronous in the spike; a large-scrollback host should drive
`Search::feed/tick` incrementally.

## Known host work not in this spike

- Draggable split handles and double-click-to-equalize.
- Single tab bar overflow, tab reordering/drag.
- Search UI parity with Stacks' search bar and result highlighting beyond the
  selected match.
- Hyperlinks, kitty graphics/images, smooth scroll, scrollbar.
- IME candidate-window positioning beyond GPUI's handler.
- GPU damage-region rendering / glyph atlas.
- Native menu, updater, automation, notifications, settings screens.

## Acceptance boundary

The parity gate covers emulator/grid state, palette, key encoding, selection
formatting, and paste encoding. It does not cover GPUI pixels, menu wiring,
persistence, or the app shell. Those are the later card's acceptance criteria.

## Card #319 host findings: adjacent-window integration

Card #319 answers the question this contract could not: can the native terminal
run *next to* the shipped Tauri app instead of replacing it? The integration
documentation lives in `docs/native-global-terminal-319.md`; these are the
host-specific facts that change the hand-off contract.

### New reusable module: `host_ipc.rs`

Transport only, no terminal logic:

- Host owns a `UnixListener`; the helper connects with
  `STACKS_NATIVE_TERMINAL_SOCKET` (or `--host-socket <path>`).
- Newline-delimited JSON. Commands are the user-intent vocabulary
  (`toggle`, `show`, `hide`, `new-tab`, `close`, `split-right`, `split-down`,
  `maximize`, `next-pane`, `previous-pane`, `next-tab`, `previous-tab`,
  `select-tab`, `search`, `clear`, `copy`, `paste`, `quit`, `ping`).
- Events are lifecycle facts (`ready`, `visibility`, `title`, `bell`,
  `quit-requested`, `error`). The reader synthesizes `quit` on EOF so the
  helper cannot outlive the host.
- `HostLink` reads on a dedicated thread and pushes into an async channel; the
  GPUI foreground task drains it with `Context::spawn_in` + `update_in`. No
  libghostty-vt handle leaves the main thread.

### Host mode (`SpikeApp::connect_host`)

- The window is created with `focus: false, show: false` and is ordered out via
  AppKit (`orderOut:`), not just rendered hidden.
- `show` → `makeKeyAndOrderFront:` + `NSApp activateIgnoringOtherApps` +
  focus the focused pane and re-send DEC mode 1004 focus-in.
- `hide` → focus-out is reported to the PTY, the AppKit window is ordered out,
  and `visibility:false` tells the host to activate Stacks again.
- `Cmd+T` inside the helper hides it and returns focus to Stacks.
- `Cmd+Q` inside the helper emits `quit-requested` and hides; Stacks keeps its
  own confirm-quit flow. `Cmd+Q` never kills the helper's PTYs directly.
- The close button hides (window `on_window_should_close` returns `false`), so
  tabs/PTYs survive a hide. Host exit is the only implicit kill path.
- Tabs/panes/focus/persistence stay helper-owned. Nothing is mirrored from
  Stacks' SQLite global-terminal layout; the two global terminals are
  deliberately independent while the spike flag is on.

### Packaging finding: a nested `.app`, not a bare binary

A bare helper binary launched from `Contents/MacOS` inherits Stacks' bundle and
cannot reliably own its own menu bar/activation. The working shape is a nested
`StacksNativeTerminal.app` (own `Info.plist`, own bundle id
`com.richcorbs.stacks.native-terminal`) shipped under
`Contents/Resources/native-terminal/`, signed inner-out before the outer app.
That is what `scripts/build-native-terminal.mjs` assembles; see the card doc for
signing/notarization implications.

### Host-owned responsibilities (implemented in `src-tauri/src/native_terminal.rs`)

- Env flag (`STACKS_NATIVE_GLOBAL_TERMINAL=1`), helper discovery, lazy launch,
  socket lifecycle, command forwarding, event relay, Stacks re-activation on
  hide, status/stop commands.
- Still host-owned but intentionally untouched by this spike: global-terminal
  persistence, search bar look/feel, settings screens, notifications, menus.

### Seam findings worth carrying forward

- **macOS accepted sockets inherit the listener's `O_NONBLOCK` flag.** A polled
  `UnixListener` produces non-blocking connections; clear the flag on the
  accepted stream or the event reader spins/trips and tears the bridge down.
  Symptom: the native window flashes open and closes.
- **Focus hand-off replays the triggering key.** The helper receives the
  in-flight `Cmd+T` (plus auto-repeat) when it takes focus, so a naive
  toggle-on-Cmd+T handler closes immediately. Ignore helper-side `Cmd+T` for a
  short window after a host-driven show, and ignore `is_held` repeats; also
  dedupe `toggle` on the host.
- **A true overlay is a different architecture.** Adjacent-window mode keeps two
  event loops; an in-window overlay/child NSWindow would couple them. That is
  the decision point for any follow-up, not a polish item.

### Remaining contract gaps

- IME candidate-window positioning across two AppKit windows is unverified.
- Clipboard is shared through the system pasteboard only (last writer wins);
  copy-on-select and OSC 52 both write it exactly as the Tauri app does.
- No inter-window drag/drop, link opening, or tab-bar drag.
- Search parity is command-level (`Cmd+F`), not UI-level.


## Card #321 shell findings

`apps/stacks-gpui` is the minimal shell built on this contract. Full report and
measurements: `docs/gpui-app-shell-321.md`.

What the shell proved:

- **The contract survives a real host.** The library crate is consumed unchanged
  except for two additive APIs: `TerminalStyle`/`prepare_frame_with_style`
  (host font settings) and `Pty::spawn_with_shell` (host shell override).
  `prepare_frame` and `Pty::spawn` remain the defaults used by the demo host and
  goldens.
- **No seam code is needed.** `host_ipc.rs`, `mac_front.rs`, the attached-overlay
  experiment, `Cmd+T` replay guard, duplicate-toggle dedupe and geometry
  mirroring are absent from the shell. One event loop, one focus handle, per-pane
  DEC 1004.
- **Window state has a GPUI trap.** `Window::bounds()` is the outer NSWindow
  frame; `WindowOptions::window_bounds` is a content rect. Persist origin +
  `viewport_size()` or the window grows by the titlebar height on every launch.
- **IME belongs to the host.** `EntityInputHandler::bounds_for_range` must map the
  focused pane's terminal cursor into the terminal element's bounds. The shell
  keeps this as a pure `ime_cursor_bounds` function with a unit test; real
  candidate-window placement still needs a human IME pass.
- **Notifications are a host service, not a terminal feature.** GPUI 0.2.2 has no
  notification API; the shell uses `osascript` as a routing stub. A production
  host needs `UNUserNotificationCenter` and authorization handling.
- **Drag/drop is a host service.** GPUI maps file drops to `ExternalPaths`; the
  shell filters Stacks' image extensions and shell-escapes paths.
- **Persistence ownership is unresolved.** The shell's JSON is a stub; the
  product still needs a Rust-side owner for global-terminal layout.
- **Menu/keyboard parity is a host responsibility.** The shell registers one
  action vocabulary for menus and keybindings; the demo host's in-`app.rs`
  shortcut handling is not the contract.
- **Use element-level action listeners in a GPUI host.** `App::on_action`
  listeners run while the window is already borrowed by action dispatch; a
  nested `WindowHandle::update` fails and the shortcut/menu item silently does
  nothing. Attach listeners to the focused root element (the shell's
  `ShellActions`) and keep a headless dispatch test for split/maximize/menu
  actions.

### Shell host services still open

- IME candidate/composition verification.
- Accessibility tree and screen-reader behaviour.
- Multi-display/Space window behaviour; GPUI 0.2.2 has no live `set_position`.
- Production notifications and permission state.
- Rust-side persistence schema for tabs/panes/cwd/titles/settings.
- Search UI parity, draggable handles, link opening, kitty graphics.
- Developer ID signing + notarization + updater for a single bundle.
