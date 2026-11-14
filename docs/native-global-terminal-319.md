# Native global terminal adjacent-window spike — card #319

**Question:** can Stacks host the native GPUI terminal as an opt-in second
native surface while the Tauri/React app remains the shell?

**Answer (preliminary, see [Verdict](#verdict)):** yes — the adjacent-window
shape works for a spike, but the focus/activation seam, packaging, and IME
behaviour are the cost centres. It is a viable *experiment*, not yet viable as a
shipped second surface. Details and evidence below.

This is an integration spike, not a migration. It builds on card #318
(`spikes/gpui-terminal/`, commit `0dbc1e2`) and adds the host bridge:
flag, helper launch, IPC, focus/shortcut handoff, packaging, and tests.

> **Follow-up (card #321):** the adjacent-window seam was not continued into the
> shell. The reusable terminal modules now live in `crates/stacks-terminal`, and
> `apps/stacks-gpui` is the minimal single-process GPUI shell. The nested-app
> packaging/signing notes below are historical for the two-app shape. Shell
> findings, measurements and verdict: `docs/gpui-app-shell-321.md`.
> `spikes/gpui-terminal/HOST_INTEGRATION.md` carries the updated contract.

## What changed

| Area | Path | Purpose |
| --- | --- | --- |
| Helper transport | `spikes/gpui-terminal/src/host_ipc.rs` | Unix socket, newline-delimited JSON, command vocabulary, lifecycle events |
| Helper host mode | `spikes/gpui-terminal/src/app.rs`, `main.rs` | Hidden start, AppKit show/hide, `Cmd+T` hand-back, quit request, close-to-hide, host event emission |
| Helper AppKit | `spikes/gpui-terminal/src/mac_front.rs` | `orderOut:`/`makeKeyAndOrderFront:` + app activation |
| Helper tests | `spikes/gpui-terminal/tests/host_ipc.rs` | Real-socket round trip, wire format, EOF quit |
| Host bridge | `src-tauri/src/native_terminal.rs` | Env flag, helper discovery, lazy launch, socket server, command forwarding, event relay, re-activation |
| Host registration | `src-tauri/src/lib.rs` | Commands, managed state |
| Frontend API | `src/nativeGlobalTerminal.ts` | Status/launch/command invokes, command mapping |
| Frontend hook | `src/hooks/useNativeGlobalTerminal.ts` | Flag detection, launch on first use, event mirroring, toasts, quit request |
| Frontend routing | `src/hooks/useAppRootModel.ts`, `src/components/AppLayout.tsx` | Route global-terminal shortcuts to the helper; skip the xterm.js overlay only when the flag is on |
| Packaging | `scripts/build-native-terminal.mjs`, `src-tauri/tauri.native-terminal.conf.json`, `package.json` | Build/sign nested `StacksNativeTerminal.app`, opt-in bundle overlay |
| Smoke test | `scripts/smoke-native-terminal.mjs` | Plays the host role against the real helper binary |

No terminal emulation, PTY, split, search, key encoding, selection, or paste code
was duplicated in the Tauri app. Stacks only sends intent and reads lifecycle
events.

## Flag and run

The switch is environment-only and dev-only. It cannot be toggled from shipped
UI and is not persisted in `settings.json`.

```bash
# 1. Build the helper (compiles gpui + libghostty-vt with Zig; several minutes)
npm run native-terminal:build

# 2a. Dev app
STACKS_NATIVE_GLOBAL_TERMINAL=1 npm run tauri dev

# 2b. Packaged branch build (helper is copied into Stacks.app resources)
npm run release:build:native-terminal
./install.sh
STACKS_NATIVE_GLOBAL_TERMINAL=1 open ~/Applications/Stacks.app --env STACKS_NATIVE_GLOBAL_TERMINAL=1
```

Debug helper builds and overrides:

```bash
npm run native-terminal:dev                 # cargo build (debug)
STACKS_NATIVE_GLOBAL_TERMINAL_BIN=/abs/path/to/helper \
  STACKS_NATIVE_GLOBAL_TERMINAL=1 npm run tauri dev
```

Helper discovery order: `STACKS_NATIVE_GLOBAL_TERMINAL_BIN` → bundled
`Contents/Resources/native-terminal/StacksNativeTerminal.app/Contents/MacOS/StacksNativeTerminal`
→ debug-build `target/{release,debug}/stacks-gpui-terminal-spike` in the workspace (older
builds may still have `spikes/gpui-terminal/target/...`).

With the flag absent (or `0`), the backend never spawns a process, never opens a
socket, and the frontend renders the original xterm.js `GlobalTerminal`
unchanged.

## Architecture

```text
Stacks (Tauri)                                  StacksNativeTerminal (GPUI)
├─ React shortcut router                         ├─ SpikeApp (tabs/panes/focus)
│   └─ Cmd+T / Shift+Cmd+T / Cmd+D / ...         ├─ TerminalModel (libghostty-vt)
├─ useNativeGlobalTerminal                       ├─ Pty (portable-pty)
│   ├─ native_terminal_launch/command  ── JSON ──▶ host_ipc reader
│   └─ "native-terminal-event"         ◀─ JSON ── host_ipc writer
└─ native_terminal.rs                            └─ AppKit window (ordered out/in)
    ├─ UnixListener (temp dir, per Stacks pid)
    ├─ helper child process
    └─ main-window re-activation on hide
```

Protocol (newline-delimited JSON over a Unix socket):

| Direction | Payload |
| --- | --- |
| host → helper | `{"command":"toggle"}` `show` `hide` `new-tab` `close` `split-right` `split-down` `maximize` `next-pane` `previous-pane` `next-tab` `previous-tab` `search` `clear` `copy` `paste` `quit` `ping` |
| host → helper | `{"command":"select-tab","index":0}` |
| helper → host | `{"event":"ready","pid":…,"version":…}` `{"event":"visibility","visible":true}` `{"event":"title","title":"…"}` `{"event":"bell","title":"…"}` `{"event":"quit-requested"}` `{"event":"error","message":"…"}` |

The listener is per Stacks process (`stacks-native-terminal-<pid>.sock` in the
temp dir) and is removed on helper exit. If Stacks disappears, the helper's
socket reader hits EOF and quits, taking its PTYs with it.

## Focus and shortcut handoff

This is the real experiment: GPUI and Tauri are separate native event loops and
separate apps. Ownership is by focus, not by a global hotkey.

| State | `Cmd+T` owner | Result |
| --- | --- | --- |
| Stacks focused, native hidden | Tauri | launches helper if needed, sends `toggle`, helper shows + activates + focuses the terminal |
| Stacks focused, native visible | Tauri | sends `toggle`, helper hides, Stacks window is focused again |
| Native focused | GPUI | hides itself, emits `visibility:false`, host shows + focuses the Stacks window |
| Native focused, `Shift+Cmd+T` | GPUI | shows (if hidden), adds a tab, focuses the terminal |
| Native focused, `Cmd+D` / `Shift+Cmd+D` / `Cmd+F` / `Cmd+K` / `Cmd+W` / `Shift+Cmd+Enter` / `Shift+Cmd+[` / `]` / `Cmd+1..9` / `Cmd+[` / `]` | GPUI | handled locally; shortcuts match Stacks' menu accelerators |
| Stacks focused, native visible, terminal shortcuts | Tauri | forwarded over the socket (split/close/search/pane/tab commands) |
| Stacks focused, native hidden, card terminal focused | Tauri | unchanged: card terminal keeps its shortcuts |
| Native red close button | GPUI | hides the window, PTYs and tabs survive |
| Native `Cmd+Q` | GPUI → host | helper sends `quit-requested` and hides; Stacks runs its normal confirm-quit flow |
| Stacks quits | — | socket EOF; helper exits and reaps PTYs |
| Stacks crashes | — | same EOF path |

Terminal input focus on open is explicit: `set_visible(true)` activates the
helper app, makes the AppKit window key, focuses the pane focus handle, and
re-sends DEC 1004 focus-in to that pane. Hiding reports focus-out before the
window is ordered out.

## Manual test checklist

Run these on macOS in a real desktop session. Start from the flag-off baseline,
then repeat with the flag on.

### Flag off (unchanged behaviour)

- [ ] Launch without `STACKS_NATIVE_GLOBAL_TERMINAL`. `Cmd+T` opens the xterm.js top-level terminal overlay.
- [ ] Typing, split (`Cmd+D`), stacked split (`Shift+Cmd+D`), search (`Cmd+F`), copy/paste, tab add/close, `Cmd+T` hide all behave as before.
- [ ] `pgrep -fl stacks-gpui-terminal-spike` prints nothing.
- [ ] No `stacks-native-terminal-*.sock` appears in `$TMPDIR`.

### Flag on — launch and toggle

- [ ] `pgrep -fl stacks-gpui-terminal-spike` is empty before the first `Cmd+T` (lazy launch).
- [ ] `Cmd+T` opens a separate native window titled `Stacks · Native terminal`, focused, terminal cursor blinking.
- [ ] Hold `Cmd+T` for a couple of seconds after opening: the window must stay open (auto-repeat is ignored).
- [ ] Shell prompt appears; `pwd` starts in `$HOME` (the helper owns its own CWD).
- [ ] Typing works immediately (no click needed). Run `vim README.md`, `:q` returns to the shell.
- [ ] `Cmd+T` hides the native window and Stacks becomes the focused app with its own window key.
- [ ] `Cmd+T` again shows the same tab/session (no new shell).

### Flag on — terminal features

- [ ] `Shift+Cmd+T` adds a tab and focuses it. `Cmd+[` / `Cmd+]` cycle tabs; `Cmd+1..9` select a tab.
- [ ] `Cmd+D` splits right, `Shift+Cmd+D` splits down. `Shift+Cmd+[` / `]` moves pane focus (Stacks parity); `Option+Cmd+[` / `]` also works.
- [ ] `Shift+Cmd+Enter` maximizes the focused pane (same as Stacks); repeat restores. `Shift+Cmd+M` also works.
- [ ] Drag-select text: it copies to the clipboard on mouse-up and shows `Copied to clipboard`. Paste with `Cmd+V` in another app works.
- [ ] `Cmd+V` in the native terminal pastes multi-line text into the shell without executing early lines unexpectedly (bracketed paste).
- [ ] `Cmd+F` opens search, typing finds scrollback matches, Enter/Shift+Enter navigates, Escape closes.
- [ ] `Cmd+K` clears the visible screen. `Cmd+W` closes the focused pane; the last pane of the last tab is a no-op.
- [ ] Resize the window: text rewraps, no right-edge gap, PTY reports the new size (`stty size`).
- [ ] `printf '\033]0;custom title\007'` updates the tab title (and the host `title` event).
- [ ] `printf '\a'` (bell) shows the `Bell` toast in Stacks.
- [ ] OSC 52: `printf '\033]52;c;%s\a' "$(printf hello | base64)"` then paste in another app yields `hello`.
- [ ] `htop`/`top` alternate screen renders and restores cleanly on quit.

### Flag on — focus and lifecycle

- [ ] From the native window, `Cmd+Q`: Stacks' quit confirmation appears (when enabled); cancelling leaves both apps usable.
- [ ] Click the native red close button: window hides, `Cmd+T` restores the same tabs and scrollback.
- [ ] Quit Stacks from its menu: the helper exits and `pgrep -fl stacks-gpui-terminal-spike` is empty.
- [ ] Kill Stacks (`kill -9`): the helper exits on socket EOF within a few seconds.
- [ ] Re-launch Stacks with the flag on: `Cmd+T` starts a fresh helper (tab layout is helper-local and intentionally not persisted across helper restarts in this spike).
- [ ] IME: switch to a Japanese/Chinese/Korean input source, type, confirm candidate positioning is adjacent to the native cursor, not the Stacks window.

## Packaging, code signing, distribution

The helper is a nested app bundle rather than a loose executable because a bare
binary cannot reliably own its own activation/menu bar next to Stacks:

```text
~/Applications/Stacks.app/Contents/Resources/native-terminal/StacksNativeTerminal.app/
├─ Contents/Info.plist        # bundle id com.richcorbs.stacks.native-terminal
└─ Contents/MacOS/StacksNativeTerminal
```

`npm run native-terminal:build` builds the release helper, assembles the bundle,
and ad-hoc signs it (`STACKS_CODESIGN_IDENTITY` overrides the identity). It
verifies with `codesign --verify --deep --strict`.

Implications not solved by this spike:

- **Signing order:** nested bundles must be signed inner-out with the same
  Developer ID as Stacks. Tauri signs the outer app but does not deep-sign
  resources. For a real Developer ID build, sign the nested app *before*
  `tauri build`, and sign/notarize the outer app afterwards. **Historical:** the
  card #321 single-bundle GPUI app removes this nested signing order entirely,
  but still needs Developer ID + notarization.
- **Notarization:** notarization must include the nested executable; the current
  project ships ad-hoc signed builds (`signingIdentity: "-"`), so Gatekeeper
  behaviour for a distributed build is unverified. Assume it needs the same
  hardened-runtime + notarization pass as Stacks and its own entitlements review.
- **Updater size:** the nested helper adds a second GPUI + libghostty-vt binary
  to the bundle, roughly doubling the download. Flag-on builds are a research
  artifact, not a release channel.
- **Hardened runtime:** a nested app launched as a child process needs the same
  runtime exceptions as Stacks if any are used; nothing here adds entitlements.
- **Kill/cleanup:** the helper is a child process of Stacks, so process-tree
  cleanup on crash/updater restart is handled by the socket EOF path. A
  production version should also register the helper for termination on logout.

## Decisions and findings

1. **Separate window, not overlay/child window.** This is why `Cmd+T` opens a
   window next to Stacks rather than an in-window overlay. GPUI owns its own
   Metal surface and event loop; Tauri's WebView owns the Stacks window. A true
   overlay would require hosting GPUI inside the Tauri window (or parenting the
   NSWindow to Stacks' window with `addChildWindow:`), which couples the two
   event loops and window lifecycles — exactly the migration the card avoids.
   The consequence users see: a distinct app window with its own menu bar,
   traffic lights, and activation, not a panel over the board. If a future card
   wants the attached look, the cheapest next experiment is an AppKit child
   window that tracks the Stacks window frame/space, still with focus handoff.
2. **Lazy launch.** Nothing spawns until the first `Cmd+T` while the flag is on.
   Flag-on-but-unused Stacks behaves like a normal build.
3. **Intent-only IPC.** Layout/persistence stay helper-owned. Sharing Stacks'
   SQLite global-terminal layout would require moving the session model out of
   React, which is exactly the migration this card avoids.
4. **`Cmd+Q` routes to Stacks.** The helper must not bypass confirm-quit or
   leave Stacks' window state unsaved.
5. **Close = hide.** PTYs survive accidental window closes; only app exit kills
   them.
6. **Activation is the fragile part.** Helper activation works from a nested
   bundle, but it is AppKit ordering + `activateIgnoringOtherApps`, not an OS
   guarantee. This needs the most hardening if the experiment continues.
7. **No state mirroring vs. duplication.** With the flag on, Stacks' xterm.js
   `GlobalTerminal` is not rendered, so there is no double-running global
   terminal. The SQLite layout is untouched and used again if the flag is off.
8. **Clipboard ownership** is the system pasteboard, last writer wins. No
   special handling was needed; copy-on-select and OSC 52 behave like the Tauri
   terminal because both write the same pasteboard.
9. **IME** is unchanged from card #318 and still needs a human pass. Cross-window
   candidate positioning is AppKit/GPUI-managed and not measurable here.
10. **macOS accepted sockets inherit `O_NONBLOCK` from the polled listener.**
    The host polls `accept()` on a non-blocking `UnixListener`; on BSD/macOS the
    accepted stream keeps that flag, so the event reader immediately failed with
    `EWOULDBLOCK`, tore down the bridge, and the helper quit — visible as
    "terminal opens and immediately closes". Fixed by clearing non-blocking
    mode on the accepted connection (and retrying transient read errors).
11. **macOS replays the in-flight `Cmd+T` to the newly focused helper.** After
    Stacks hands focus over mid-press, the helper receives the same `Cmd+T`
    key-down (and auto-repeat) and used to hide itself again. Fixed by ignoring
    helper-side `Cmd+T` for 600 ms after a host-driven show and ignoring held
    (auto-repeat) key-downs. The host also drops duplicate `toggle` commands
    within 250 ms.

## Validation performed

```bash
npm run test        # 169 files / 1406 tests
npm run build       # tsc + vite
cd src-tauri && cargo check
cd spikes/gpui-terminal && cargo test --test host_ipc   # 3 transport tests
```

See the evidence table below for the host smoke run and any manual items that
still need a human.

| Check | Result |
| --- | --- |
| Flag-off frontend suites | PASS (`npm run test`) |
| Flag-off production build | PASS (`npm run build`) |
| Host backend compiles | PASS (`cargo check`) |
| Helper compiles (host mode) | PASS (`cargo check --all-targets`, `cargo build --release`) |
| IPC transport tests | PASS (`tests/host_ipc.rs`, 3 tests: round trip, wire format, EOF quit) |
| Host-driven helper smoke (release binary) | PASS: ready → visibility:true → two title events → hide → visibility:false → clean quit |
| Host-driven helper smoke (bundled nested app) | PASS: same script against `Stacks.app/Contents/Resources/native-terminal/...` |
| Opt-in release build | PASS: `npm run release:build:native-terminal` bundles the helper, `codesign --verify --deep --strict` passes |
| Manual desktop checklist | REQUIRES HUMAN (typing/clipboard/IME/focus) |

### Host smoke run

```bash
npm run native-terminal:smoke
```

Plays the Tauri host role: binds the socket, spawns the real helper, sends
`show → new-tab → split-right → split-down → next-pane → new-tab →
previous-tab → select-tab → search → hide → quit`, and asserts `ready`,
`visibility:true`, `title`, and `visibility:false` events plus a clean exit.
It exercises the real desktop window briefly. Latest run: all steps passed, both
against the standalone release binary and against the helper embedded in the
packaged `Stacks.app`.

`spctl -a` rejects the nested helper exactly like the ad-hoc signed Stacks app
(`rejected`); that is the existing distribution model, not a regression. A real
distribution build needs the Developer ID pipeline described above.

## Verdict

**Go for continued adjacent-window experimentation; no-go for shipping a second
native surface now.**

Evidence for "go":

- A branch build with the flag on launches a usable native global terminal from
  Stacks without touching terminal emulation code in the Tauri app.
- `Cmd+T` toggles it, PTYs persist across hide/show, splits/tabs/search/copy/
  paste are the card #318 implementations, and the xterm.js global terminal is
  byte-for-byte the same code path when the flag is off.
- The IPC boundary is small, testable, and transport-only; the helper dies with
  Stacks via socket EOF.
- Packaging as a nested app bundle is reproducible from a script.

Evidence against shipping now:

- Focus handoff is cooperative. Two apps, two event loops, and AppKit ordering
  behave, but there is no hard guarantee against focus races, and a global
  hotkey cannot be owned by both apps. That is acceptable for a dev flag, not
  for a default terminal.
- Distribution cost is real: a second signed/notarized binary, roughly doubled
  bundle size, and a nested-app signing pipeline that this repo does not have.
- IME candidate positioning, accessibility, and multi-display/multi-space
  behaviour are unverified.
- Two independent global terminals (xterm.js and native) means layout, tabs, and
  scrollback do not move with the flag; users would perceive data loss.

### Recommendation

Do **not** start a Tauri→GPUI migration from this result. Use it as the
integration contract for the next decision:

1. **GPUI app-shell spike** if the goal is "Stacks entirely native". The
   adjacent-window seam is the wrong long-term architecture; the card #318
   shell modules (`terminal_model`, `terminal_surface`, `split_tree`, `pty`,
   `keymap`) are already shell-agnostic.
2. **Adjacent-window hardening** only if the product wants a native terminal
   *alongside* Tauri for a while. That work is: focus-race instrumentation,
   IME/accessibility audits, nested-bundle signing/notarization, helper state
   persistence, and a `Cmd+T` arbitration policy.
3. **Stop the native experiment** if the only goal was the Cmd+T surface: the
   xterm.js terminal already ships it, and the native advantage is unproven
   outside the rendering path.

## Follow-up card

Recommended: **GPUI app-shell spike** — take `HOST_INTEGRATION.md`'s reusable
modules and build a minimal GPUI shell (sidebar/kanban placeholder, global
terminal, window/menu/persistence) behind a separate branch, then compare
focus/IME/packaging against this adjacent-window result before any conversion
work.

**Done in card #321:** `crates/stacks-terminal` + `apps/stacks-gpui`. Result:
go for a single native app as the migration target, no-go for a cutover yet.
See `docs/gpui-app-shell-321.md`.
