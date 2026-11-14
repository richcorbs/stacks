# GPUI + libghostty-vt global terminal demo host (cards #318/#319)

An isolated, runnable reproduction of Stacks' **Cmd+T global terminal** on a
native GPU UI stack. Nothing here is imported by the shipped Tauri app.

Card #321 extracted the reusable terminal modules into
`crates/stacks-terminal`; this crate is now the demo/adjacent-window host on top
of that library. See `docs/gpui-app-shell-321.md` for the shell spike and
`HOST_INTEGRATION.md` for the host contract.

## Scope

In:

- One window with the global terminal overlay behaviour.
- Tabs, add, close, Cmd+T show/hide, Shift+Cmd+T new tab, Cmd+W close.
- Split panes with Cmd+D / Shift+Cmd+D, focused-pane navigation, maximize.
- Incremental scrollback search with Cmd+F.
- Real `portable-pty` shell, login shell, generation ids.
- libghostty-vt emulation: VT parsing, scrollback/reflow, alternate screen,
  truecolor, title/bell/OSC 52 events, bracketed paste, Kitty key protocol.
- GPUI rendering from `render.h` state, keyboard/mouse/IME input.

Deliberately out: kanban, card detail, Pi chat, DIFF, native menus, updater,
notifications, automation, settings screens, replacing Tauri. The reusable
hand-off contract is in `HOST_INTEGRATION.md`.

## Host mode (card #319)

The spike can also run as Stacks' adjacent native global terminal. Stacks starts
the helper as a child process and drives it over a Unix socket
(`src/host_ipc.rs`); the helper starts hidden and shows/hides its AppKit window
on command. Nothing is imported by the shipped Tauri app, and the helper owns
its own tabs/panes/PTYs.

```bash
# from the repository root
npm run native-terminal:build                  # release helper + nested app bundle
STACKS_NATIVE_GLOBAL_TERMINAL=1 npm run tauri dev

# host-side smoke test (plays the Tauri bridge role)
npm run native-terminal:smoke
```

Integration report, focus matrix, manual checklist, and verdict:
`docs/native-global-terminal-319.md`.

## Run

```bash
cd spikes/gpui-terminal
cargo run
```

Deterministic visual fixture (no shell):

```bash
SPIKE_DEMO=1 cargo run
```

Useful debug switches:

```bash
SPIKE_INPUT_DEBUG=1 cargo run   # log keys that reach the terminal
SPIKE_ON_TOP=1 cargo run        # test-only: raise window above normal windows
```

Shortcuts (aligned with Stacks): `Cmd+T` show/hide, `Shift+Cmd+T` new tab,
`Cmd+W` close pane/tab, `Cmd+D` split right, `Shift+Cmd+D` split down,
`Cmd+F` search, `Cmd+K` clear screen, `Shift+Cmd+Enter` maximize/restore pane
(`Shift+Cmd+M` also works), `Cmd+1..9` select tab, `Cmd+[`/`Cmd+]` cycle tabs,
`Shift+Cmd+[`/`]` cycle panes (`Option+Cmd+[`/`]` also works), `Cmd+C` copy
selection, `Cmd+V` paste, `Cmd+Q` quit.

## Tests

Terminal tests and the parity harness moved to `crates/stacks-terminal` with the
modules in card #321. From the repository root:

```bash
cargo test --workspace              # terminal, demo host, shell
npm run gpui-shell:parity           # xterm.js <-> libghostty-vt parity

# Real programs over a disposable PTY (vim/less/git; htop if installed)
cargo test -p stacks-terminal --test tui_smoke -- --test-threads=1 --nocapture

# 120 Hz CPU-budget measurement
cargo test -p stacks-terminal --release --test bench_120hz -- --ignored --nocapture

# Regenerate the visual golden if the render model intentionally changes
UPDATE_VISUAL=1 cargo test -p stacks-terminal --test visual_test
crates/stacks-terminal/scripts/visual-test.sh   # writes golden.png with ImageMagick
```

`visual-tests/golden.svg` and `golden.png` are model-level goldens: they
rasterize the exact `Frame` handed to GPUI's paint path (colors, glyphs, wide
cells, cursor). gpui 0.2.2 does not publish Zed's `visual_test` platform API, so
this is not a Metal framebuffer readback.

## Architecture

```text
crates/stacks-terminal/   reusable library (consumed by both native binaries)
  src/pty.rs              portable-pty spawn/write/resize, generation ids, async events
  src/terminal_model.rs   libghostty-vt wrapper -> plain Frame/Cell data
  src/terminal_surface.rs cell metrics, shaped rows, cursor, marked-text paint
  src/split_tree.rs       reusable pane split tree and focus math
  src/keymap.rs           GPUI keystroke -> Ghostty key/modifier mapping
  src/fixtures.rs         deterministic render fixture (visual test support)
  src/parity.rs           shared xterm.js parity corpus runner
  parity/                 xterm.js harness, corpus, known divergences, key parity
apps/stacks-gpui/         minimal GPUI app shell (card #321)
spikes/gpui-terminal/
  src/app.rs              demo host: tabs, panes, chrome, input, selection, IME, search
  src/host_ipc.rs         adjacent-window transport (card #319 only)
  src/mac_front.rs        test-only NSWindow raise/show helper
HOST_INTEGRATION.md       hand-off contract for the full GPUI app-shell card
```

The PTY reader thread sends bytes through a bounded `async_channel`; the GPUI
foreground task feeds libghostty-vt and calls `cx.notify()`. Terminal handles
remain on one thread (`!Send + !Sync`), as required by libghostty-vt.

## Licences

- `gpui` 0.2.2: Apache-2.0.
- `ghostty-vt` 0.8.0 / libghostty-vt: Apache-2.0 wrapper, Ghostty MIT.
- No Zed terminal/editor/app crates are copied or linked.

Build is pinned by `Cargo.lock` to Ghostty `1.4.0-main.83fb956`; the sys crate
builds the official source tarball with Zig 0.17. `rust-toolchain.toml` at the
repository root pins Rust 1.99.1.

## Known gaps

- Split/panes are implemented, without draggable divider handles yet.
- Search is implemented; hyperlinks, kitty graphics/images, scrollbar and
  smooth scroll are not.
- Parity is at the emulator/grid and keyboard-encoder level; GPUI's rendered
  pixels are covered by the model-level visual golden, not a Metal capture.
- xterm.js has no Kitty keyboard protocol, so side-by-side key parity covers
  legacy + application-cursor encoding; Ghostty's Kitty path has unit tests
  but no xterm comparison.
- The spike now installs xterm.js' default 256-color ANSI palette, so resolved
  ANSI colors match Stacks. A future port must keep this explicit.
- Font fallback/shaping for emoji, combining marks and ligatures is GPUI +
  Menlo; wide glyph alignment needs a real glyph atlas for production parity.
- IME composition is wired and rendered as marked text, but needs a human pass
  with the actual input method you use. The card #321 shell keeps the same
  plumbing and anchors candidates to the terminal cursor.
- The demo host still owns its own tabs/panes when run through `host_ipc.rs`;
  that seam is intentionally absent from `apps/stacks-gpui`.
- GPU frame pacing/present timing is not measured; the 120 Hz number is emulator
  + render-state CPU time only.
