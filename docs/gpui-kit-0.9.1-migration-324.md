# GPUI 0.9.1 migration — card #324 (folded into #323 branch)

**Result:** the native workspace is on **GPUI 0.3.12 + GPUI Kit 0.9.1**.
The Cards surface, read-only detail, terminal shell and #319 native-terminal
spike all build and test. AccessKit is in the dependency graph.

Card #324 was created for this migration, then folded back into the #323
branch/worktree at the user's request so the GPUI Kit adoption, native detail
and foundation upgrade stay together. No second branch is active.

## What changed

### Workspace

```text
gpui          -> package gpui-pre           =0.3.12
gpui_platform -> package gpui-pre-platform  =0.3.12 (+ font-kit)
apps/stacks-gpui:
  gpui-component 0.5.1 -> gpui-kit 0.9.1
```

`gpui-kit` supplies GPUI, Base, Component, theme and assets. `gpui` remains a
direct dependency so the existing `use gpui::...` code stays source-compatible.

### Application bootstrap

- `Application::new()` -> `gpui_kit::application()`.
- `gpui_component::init` -> `gpui_kit::init`.
- Manual `gpui_component::Root` wrapper -> `gpui_kit::open_window`, which wraps
  the application view in Base `Root`.
- `on_window_closed` now takes `(cx, window_id)`.
- `Menu` gained a `disabled` field.

### Terminal library

`crates/stacks-terminal` needed exactly four text-paint changes:

```rust
line.paint_background(row_origin, line_height, TextAlign::Left, None, window, cx);
line.paint(row_origin, line_height, TextAlign::Left, None, window, cx);
marked.paint_background(marked_origin, line_height, TextAlign::Left, None, window, cx);
marked.paint(marked_origin, line_height, TextAlign::Left, None, window, cx);
```

### Shell / spike API pass

- `FocusHandle::focus` and `Window::focus` now take `&mut App`.
- `on_scroll_wheel`/`ScrollWheelEvent` -> `on_scroll`/`ScrollEvent`.
- `gpui_component::component` path -> `gpui_kit::component`.
- `TextView::markdown(id, text)` no longer needs `Window`/`App` at construction.
- `gpui-platform` initializes the #319 spike application.
- The #319 spike migrated its focus calls and scroll names.

### Tests

GPUI 0.3.12's test scheduler rejects background-thread activity. `Shell` tests
now build pane models without spawning a real PTY; production still spawns the
login shell. PTY I/O remains covered by the terminal integration suite.

The #319 host IPC test now treats the socket write timeout as best-effort:
macOS can reject `SO_SNDTIMEO` after the peer closes, and the EOF case exercises
exactly that ordering.

## Measurements

Release, live database, 5 runs for LIST, 3 for terminal, same scripts as #322.

| Check | Hand-rolled `gpui 0.2.2` | `0.5.1` bridge | **`0.9.1`** |
| --- | ---: | ---: | ---: |
| First shell frame | 86.4 ms | 104.8 ms | **116.5 ms** |
| First LIST frame | 167.4 ms | 209.0 ms | **194.2 ms** |
| Card model load | 15.2 ms | 6.1 ms | **3.9 ms** |
| Row flatten/group | 25.7 µs | 28.5 µs | **24.1 µs** |
| Visible rows | 13 | 13 | **13** |
| RSS after LIST | 76.9 MB | 80.4 MB | **83.5 MB** |
| Release binary | 9.04 MB | 16.19 MB | **20.21 MB** |
| Headless scroll median (2,137 cards) | 0.55 ms | 0.76 ms | **0.52 ms** |
| Headless scroll p95 | 0.92 ms | 1.08 ms | **0.82 ms** |
| Terminal first frame | — | — | **122.4 ms** |
| Terminal RSS | — | — | **86.2 MB** |

Read-only detail with live card #322 (7,092 chars, 15 events): **18.2 ms** to
first detail frame, **3.6 ms** DB load, **94.1 MB** RSS while detail is open.

The 0.9.1 layer costs roughly **30 ms at first shell frame**, **27 ms at first
LIST frame**, **3.1 MB RSS** and **4.0 MB binary** over the 0.5.1 bridge. It is
faster than 0.5.1 at LIST frame and scroll because Base/virtualization and the
text pipeline improved. The binary growth is mostly Base/Component/assets/
AccessKit.

## Accessibility

AccessKit is present:

```text
gpui-pre 0.3.12 -> accesskit 0.24.1
                -> accesskit_macos 0.26.3
                -> accesskit_consumer 0.38.0
```

The app's own `gpui-kit` test-support feature was **not** enabled because
`gpui-kit 0.9.1`'s test-support feature pulls optional `gpui-fast` crates whose
exact pins (`taffy 0.15.0`, `unicode-properties 0.1.3`) conflict with the
`gpui-pre 0.3.12` pins (`taffy 0.15.1`, `unicode-properties 0.1.5`). This is an
upstream package-resolution issue, not an app code issue. The AccessKit
dependency and Base accessibility behavior are present; a dedicated a11y test
pass should use a manually pinned `gpui-fast`/Kit test-support setup or wait for
an upstream feature fix.

## Webview seam

`gpui-webview 0.9.1` is published as a separate crate (Wry/WKWebView) and is
available for the hybrid fallback. It is not embedded in this migration. Its
documented limits still apply: native child view, experimental macOS,
overlay/focus interactions, and a separate IPC/security boundary for the React
detail.

## What remains

- Human visual pass on the migrated shell/detail: kit theme, density, spacing,
  Stacks identity.
- Human keyboard/IME/drag pass; GPUI 0.3.12 changed focus/input APIs.
- A11y test-support dependency conflict (upstream) before automated a11y tests.
- `spikes/gpui-terminal` helper smoke test with the Tauri host
  (`npm run native-terminal:smoke`) in an environment with display access.
- Deep UI polish (separate follow-up) now on the current foundation.
- Webview embed decision if native detail cannot cover a future rich surface.

## Validation

| Check | Result |
| --- | --- |
| `cargo check --workspace --all-targets` | PASS |
| `cargo test --workspace` | PASS |
| `cargo test -p stacks-gpui` | PASS: 14 tests |
| `cargo test -p stacks-cards` | PASS: 3 unit + 6 read-model |
| `npm run test` | PASS: 168 files / 1,341 tests, 2 skipped |
| `npm run build` | PASS |
| `cd src-tauri && cargo check` | PASS |
| Live Cards launch | PASS: 139 cards, 13 visible rows |
| Live terminal launch | PASS |
| Live native detail (`STACKS_GPUI_OPEN_CARD=322`) | PASS: 18.2 ms, 15 events |
| AccessKit dependencies | PRESENT |
| `gpui-kit` test-support a11y test | BLOCKED by upstream `gpui-fast` pin conflict |
| #319 helper bundle build (`node scripts/build-native-terminal.mjs --debug --no-sign`) | PASS |
| Live screenshot | BLOCKED by macOS screen-recording permission |
