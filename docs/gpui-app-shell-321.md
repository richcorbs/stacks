# GPUI app-shell spike — card #321

**Question:** now that card #319 proved the native terminal can run *next to*
Tauri but showed the two-app seam is the wrong long-term architecture, should
Stacks move the **whole shell** to GPUI?

**Answer:** **Go for a single-native-app as the migration target; no-go for a
cutover from this spike.** The reusable terminal surface moves into a normal
library crate unchanged, and a minimal GPUI shell runs the global terminal,
menus, keybindings, focus, IME plumbing, drag/drop, notifications and
persistence with one process and one bundle. The remaining blockers are not
architectural unknowns in the terminal; they are the unported product surfaces
(kanban/Pi/DIFF/GitHub), accessibility/IME verification, and the Rust-side data
ownership decision. Details and measurements below.

## What was built

```text
Cargo.toml                      workspace: apps/*, crates/*, spikes/* (src-tauri excluded)
crates/stacks-terminal/         reusable library: terminal_model, terminal_surface,
                                split_tree, pty, keymap, parity harness/goldens
apps/stacks-gpui/               minimal shell: chrome, menu, keybindings, global
                                terminal, settings/state (no project sidebar)
spikes/gpui-terminal/           card #318/#319 demo host; now depends on the library
```

The spike's `terminal_model.rs`, `terminal_surface.rs`, `split_tree.rs`,
`pty.rs`, `keymap.rs`, parity runner, parity corpora and visual goldens moved to
`crates/stacks-terminal` with `git mv`; the demo host consumes them through a
path dependency. There is one source of truth and the terminal code is now in
normal `cargo check`/`cargo test` coverage.

Only two small API additions were needed for the shell:

| Change | Why |
| --- | --- |
| `terminal_surface::TerminalStyle` + `prepare_frame_with_style` | The shell's settings stub controls font family/size/line height. `prepare_frame` remains as the default wrapper, so the spike and goldens are unchanged. |
| `pty::Pty::spawn_with_shell` | Settings stub can override the login shell; `Pty::spawn` keeps the old signature. |

`fixtures.rs` also moved into the library because the visual golden depends on
it; it remains demo/test support and is not used by the shell.

## Run

```bash
# debug shell (one window, global terminal)
cargo run -p stacks-gpui

# tests / parity / packages
npm run gpui-shell:test
npm run gpui-shell:parity
npm run gpui-shell:build
npm run gpui-shell:bundle     # dist-gpui/Stacks GPUI Shell.app (ad-hoc signed)
```

Debug builds use `~/Library/Application Support/stacks-gpui-dev/`; release
builds use `stacks-gpui/`. Override with `STACKS_GPUI_DATA_DIR`.

## Shell scope

In:

- One window with a top bar, tab bar and terminal grid. There is intentionally
  no project sidebar or kanban placeholder; that layout predates the product
  pivot and was removed after review rather than ported into the native shell.
- Native menu bar (`Stacks`, `Terminal`, `Window`) with Stacks' terminal
  accelerators generated from the GPUI keymap.
- One global terminal tab set with splits, maximize, close, search, clear,
  copy-on-select, paste, tabs.
- Focus handling in a single event loop (activation observer + per-pane DEC
  1004 focus reporting).
- IME plumbing (`EntityInputHandler`, marked-text painting, cursor-adjacent
  `bounds_for_range`).
- Image-file drop-to-terminal path insertion with Stacks' extension list and
  shell escaping.
- Bell/OSC-notification routing to a toast plus an `osascript` notification
  stub.
- JSON settings and window/layout persistence stubs.

Out (per card): kanban, card detail, Pi chat, DIFF, GitHub/Superthread,
settings screens, updater UI, cutover, deleting Tauri.

## Measurements

Method: release build on macOS 15.7.7 arm64, 5 runs for the GPUI shell,
`scripts/measure-gpui-shell.mjs`. GPUI timing starts at the first statement in
`main` (`mark_process_start`) and ends at the first `render()`. Tauri startup
could not be measured cleanly because the running dogfood instance owns the
automation socket: a second launch activates the existing app and exits. Tauri
memory is a sample from that long-running instance, so it is an upper bound, not
a cold-start comparison.

| Check | GPUI shell | Tauri app |
| --- | --- | --- |
| First render (includes first PTY spawn) | 68.8–93.7 ms, median **76.5 ms** | not measurable (single-instance activation) |
| First render, bundled `.app` launch | **96–113 ms** (two runs) | not measurable |
| RSS after first prompt | **72.7–73.5 MB**, median **73.1 MB** single process | main **118.9 MB**; WebKit GPU/Network/WebContent helpers add **~733 MB** at sample time (~**852 MB** total) |
| Binary / bundle size | **6.87 MB** binary, **6.90 MB** single `.app` | **7.2 MB** `.app`, 7.1 MB main binary + `dist`/assets |
| Signing | ad-hoc (`codesign --deep --strict` passes); `spctl` rejects exactly like Tauri | ad-hoc (`signingIdentity: "-"`); `spctl` rejects |
| Nested helper | none | none in shipped build; the #319 helper pipeline is opt-in |
| Process count | 1 | 1 app + WebKit helper processes |

Notes:

- The PTY spawn dominates the GPUI first frame; the GPUI/terminal render path is
  a small fraction of the 60–116 ms. The bundle run is slower because
  LaunchServices/AppKit activation happens before the first frame.
- The memory comparison is directional, not a benchmark: the Tauri sample had
  many long-lived workspaces/Pi processes. A fresh Tauri window would still
  carry WebKit helper processes; the point is that the GPUI shell has no second
  runtime.
- Bundle size is a wash today because both apps are thin. The GPUI bundle has no
  nested helper and no web assets; a single-app GPUI migration would ship one
  signed binary instead of an app + WebView runtime + nested helper option.

## Shell-level gaps measured in this spike

| Gap | Result |
| --- | --- |
| Focus in one event loop | **Works.** Activation observer reports gain/loss; launch/activate traced `focus gained`, switching to Finder traced `focus lost`. Per-pane DEC 1004 focus is sent per pane; no two-app replay guard is needed. |
| IME candidate positioning | **Plumbing verified, real IME pending human pass.** Plain layouts write directly to the PTY; IME layouts route through `EntityInputHandler`. `bounds_for_range` anchors to the focused pane's terminal cursor, and a unit test asserts the anchor (element origin + padding + cursor cell), not the window origin. |
| Drag/drop | **Wired, real drag pending human pass.** GPUI `on_drop::<ExternalPaths>`; image extensions match Stacks; paths are POSIX-shell escaped. Unit tests cover filtering/escaping. |
| Notifications | **Stub works, production API missing.** Bell/OSC notifications update the toast and call `osascript display notification` (exit 0 verified). Needs `UNUserNotificationCenter`, authorization state and action routing. |
| Window state | **Works; found and fixed a bug.** `Window::bounds()` is the outer NSWindow frame while `WindowOptions` takes a content rect, so naive restore grew the window by the titlebar height every launch (28 px). Persisting origin + `viewport_size()` is stable across three relaunches (1180×760). |
| Persistence ownership | **Stub only.** The shell owns JSON in `stacks-gpui[-dev]/`. The product still needs a Rust-side owner for global-terminal layout/cwd/titles; the current React side owns the SQLite layout. |
| Menu/keyboard parity | **Wired and table-tested; real keystroke pass pending.** Bindings and menu items share one action vocabulary; tests assert the exact shortcut-to-action table. Automated key injection was blocked by macOS Accessibility permission for the agent process. |
| Maximized pane navigation | **Fixed.** A maximized pane is rendered from `maximized` rather than the split tree, so `Shift+Cmd+[`/`]` changed `focused` without changing what was visible. Pane navigation now moves `maximized` with `focused`; the headless action test covers Previous/Next while maximized. |
| Action dispatch | **Fixed.** Global `App::on_action` listeners ran inside window action dispatch; updating the window from there failed because GPUI had already taken it out of `App::windows`, so `Cmd+D` / menu items silently no-op'd. Listeners now live on the focused root element (`ShellActions`). A headless GPUI test dispatches split/split-down/maximize/close/new-tab and asserts pane/tab state. |
| Window title / tab titles | Works: focused pane title drives the window title and tab label. |
| Search | Command-level only: incremental model search with a small overlay, next/prev/escape. Stacks' search bar look/feel and all-match highlighting are not ported. |
| Settings screen | Stub overlay displays effective values; edit JSON + relaunch. Not a settings UI. |
| Multi-display/Space behavior | Not measured (requires a human with a second display/Space). GPUI has no `set_position` API in 0.2.2; persisted position is applied through `WindowOptions`, so first-open placement works but live repositioning is host work. |
| Accessibility | Not measured. GPUI 0.2.2 exposes no app-level accessibility tree for terminal cells. |
| Updater | Not ported. A single app removes the nested-helper signing order but still needs Developer ID + notarization and an updater strategy. |

## Decisions

1. **Extract, don't copy.** The five terminal modules are a library crate. The
   spike stays as short as possible and is now a demo host with only
   `app.rs`/`host_ipc.rs`/`mac_front.rs`.
2. **Do not carry the two-app seam into the shell.** `host_ipc.rs`, the
   `frame`/attached-overlay idea, the `Cmd+T` replay guard, toggle dedupe,
   socket `O_NONBLOCK` workaround and geometry mirroring are absent from
   `apps/stacks-gpui`. In a single process there is no host, no socket, and no
   second window.
3. **One action vocabulary, element-level listeners.** Menus and keybindings use
   the same `actions!` types. Listeners are attached to the focused root element,
   not `App::on_action`: global listeners execute while GPUI has the window
   borrowed for dispatch, so calling `WindowHandle::update` from them silently
   fails. A headless test dispatches the split/maximize/close actions; another
   keeps the shortcut table honest.
4. **The shell owns settings/state in JSON for the spike.** This is enough to
   prove ownership and restore, not the final schema. Do not migrate the
   product's SQLite until a Rust-side data owner is designed.
5. **Notifications stay a stub.** `osascript` proves routing; it is not a
   distribution-quality notification implementation.
6. **No project/sidebar placeholder.** The first pass copied Stacks' old
   project sidebar shape as static chrome because card #321 asked for a
   "placeholder sidebar/kanban region". That scope was stale after the product
   pivot, so the sidebar, kanban placeholder, sidebar toggle and persisted
   sidebar state were removed. The shell is a full-width terminal workspace.

## Remaining work before a migration decision can become a cutover

- Human passes: IME candidate/composition on Japanese/Chinese/Korean; real
  drag/drop; menu/keyboard parity; accessibility; multi-display and Spaces;
  notification authorization.
- Product surface feasibility: card detail/Pi chat/DIFF/GitHub/Superthread in
  GPUI, and whether the web stack stays for those surfaces behind a hybrid
  window (which would reintroduce much of the current runtime cost). The
  surviving LIST surface was spiked separately in card #322 and is feasible in
  pure GPUI (see below).
- Data ownership: move global-terminal layout/tabs/cwd/titles and app settings
  to Rust before the webview stops owning them.
- Rendering: glyph atlas + damage regions for production scrolling/latency;
  draggable split handles, link opening, kitty graphics/images.
- Distribution: Developer ID signing, hardened runtime, notarization, updater,
  crash reporting, automation CLI.

## Validation performed

| Check | Result |
| --- | --- |
| `cargo check --workspace --all-targets` | PASS (terminal library, demo host, shell) |
| `cargo test --workspace` | PASS: 17 library unit tests + 13 terminal integration tests + 3 demo host unit + 3 `host_ipc` + 8 shell unit tests (1 benchmark ignored) |
| `npm run test` | PASS: 169 files / 1406 tests |
| `npm run build` | PASS (tsc + Vite) |
| `cd src-tauri && cargo check` | PASS (workspace `exclude` keeps the Tauri crate independent) |
| `npm run gpui-shell:parity` | PASS: 98 snapshots, 0 unknown grid differences, 14 recorded divergences; 38 key cases, 7 selection cases, 6 paste cases |
| `node scripts/measure-gpui-shell.mjs --runs 5` | PASS: median 76.5 ms first frame, 73.1 MB RSS |
| `node scripts/bundle-gpui-shell.mjs` | PASS: 6.90 MB bundle, `codesign --verify --deep --strict` passes; `spctl` rejects (ad-hoc, same as Tauri) |
| `npm run native-terminal:build -- --debug` + `npm run native-terminal:smoke` | PASS: updated helper paths; ready/show/hide/title/quit lifecycle |
| Manual: IME candidate placement, drag/drop, real menu/keyboard events, accessibility, Spaces/multi-display, notification permission | REQUIRES HUMAN |

## Verdict

**Go: single native app is the right long-term architecture. No-go: do not
schedule a cutover yet.**

Evidence for "go":

- The card #318 terminal modules move into a library and the shell consumes them
  without terminal-code duplication; `cargo test --workspace` covers them.
- A minimal GPUI shell launches, runs a real login shell, splits, searches,
  copies/pastes, tracks focus, and persists window/layout state in one process.
- Startup is fast (~77 ms median to first frame including PTY spawn), memory is
  ~73 MB in one process, and packaging is one 6.90 MB bundle with no nested
  helper or second signing pipeline.
- The shell-level gaps that #319 could not test are now either working
  (focus, window state, drag/drop wiring, IME anchor) or explicitly stubbed
  (notifications, settings UI, persistence schema) rather than assumed.

Evidence against a cutover now:

- IME candidate placement, accessibility, keyboard/menu behaviour with real key
  events, multi-display/Space behaviour and notification authorization still
  need human verification.
- Kanban, card detail, Pi chat, DIFF and integrations are unported; migrating
  them is the bulk of the work and may argue for a hybrid shell.
- Terminal rendering still repaints shaped rows; a production terminal needs a
  glyph atlas/damage rendering.
- Distribution is not solved by a single bundle; Developer ID signing,
  notarization, updater and crash reporting remain.

Recommended next step if the product wants to continue: a **product-surface
feasibility card** for kanban/Pi/DIFF in GPUI plus a **human accessibility/IME
pass** on this shell, before any data-model migration.


## Product-surface follow-up — card #322

Card #322 tested the surviving **LIST** surface (the board/lanes are being
removed separately) on this shell. Full report:
[`gpui-list-view-322.md`](gpui-list-view-322.md).

Result: **LIST is viable in pure GPUI.** A new `crates/stacks-cards` read model
opens the shipped `workflow.sqlite3` read-only, owns the status/group/delivery
projection, and supports backlog reorder with the same
`KANBAN_REORDER_CONFLICT` contract. `apps/stacks-gpui/src/list.rs` renders real
cards with groups/counts/collapse, project filter, loading/error/empty states,
row metadata, keyboard navigation, an open-card placeholder seam, and GPUI drag
reorder. A 2,137-card fixture still renders only 13–20 rows via `uniform_list`.

Release measurements: first LIST frame **167 ms** median against the live 137-card
database and **161 ms** for 2,137 cards; card query **15–22 ms**; row flatten
**26–363 µs**; RSS **77–80 MB**; headless scroll layout/prepaint **0.55 ms**
median / **0.92 ms** p95. Accessibility remains absent in GPUI 0.2.2, and rich
detail/integration surfaces are still unspiked.

This narrows the #321 decision: the LIST shell does **not** require a hybrid
webview. The open question is card detail (native vs. embedded webview), plus a
human accessibility pass before any cutover. It does **not** change the #321
shell verdict or schedule a cutover.
