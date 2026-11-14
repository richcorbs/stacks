# GPUI Kit adoption + native card detail — card #323

**Question:** should Stacks keep hand-rolling GPUI UI, and can card detail be a real native surface?

**Answer:** **Use GPUI Kit, and target the current `gpui-kit 0.9.1` line.**
We integrated the last GPUI-0.2.2-compatible release (`gpui-component 0.5.1`)
as a working proof; it is better than hand-rolling, but it is a dead-end
compatibility line. The current kit gives AccessKit accessibility, current
components, Markdown, virtual lists/tables, webview and testing, and the
terminal library moves to its `gpui-pre 0.3.12` base with **four signature
changes**. The next card should perform that upgrade rather than build more UI
on 0.5.1.

For card detail: a **native read-only detail is viable** with GPUI Kit
components. A hybrid webview remains available through `gpui-webview` (Wry), but
is not required for read-only detail and is still experimental.

## Why Stacks wasn't using gpui-kit

`gpui-kit.com` is the site for `longbridge/gpui-kit` (Apache-2.0, ~20.5k stars,
weekly releases). It was not used before because:

- cards #318/#321 were terminal-first spikes and intentionally kept the
  dependency surface small;
- #322 proved bare-GPUI LIST mechanics without comparing component frameworks;
- the current kit requires `gpui-pre 0.3.12`, while Stacks pins `gpui 0.2.2`;
- using the last 0.2.2-compatible release (`gpui-component 0.5.1`) is a
  temporary bridge, not the current product.

That was a gap in the earlier spikes. This card closes it.

## What was built / evaluated

### Track A — `gpui-component 0.5.1` on GPUI 0.2.2 (implemented)

- Added `gpui-component = "0.5.1"`.
- Initialized `gpui_component::init(cx)` before opening the window.
- Wrapped the shell in `gpui_component::Root`.
- Replaced hand-rolled list controls/badges with:
  - `Button` for refresh and project filter;
  - `Tag` for group counts, project, delivery/status, hierarchy, environment
    warning and PR/CI badges;
  - `Spinner` for detail loading.
- Replaced the custom Markdown subset parser with `TextView::markdown`.
- Card detail is now a real read-only native surface loaded from
  `stacks-cards::load_detail`:
  - title, project, status/delivery, revisions, board/list, assignees;
  - environment and PR metadata with blockers;
  - hierarchy navigation (parent/children open the detail);
  - last 30 card events;
  - copy-reference and open-card-URL actions;
  - loading/error/retry and Escape-to-close.
- Kept the existing LIST read model, drag reorder, keyboard navigation and
  virtualization.

This is a real adoption, not a screenshot-only probe. `gpui-component 0.5.1`
compiles against the current GPUI and the shell launches with it.

### Track B — `gpui-kit 0.9.1` on `gpui-pre 0.3.12` (probed)

A minimal `gpui-kit 0.9.1` crate compiles cleanly. It pulls AccessKit
(`accesskit`, `accesskit_macos`) and the current component/base/webview layers.

I copied `crates/stacks-terminal` and repointed it at
`gpui-pre = 0.3.12`. It compiled after **four** text-paint calls gained
`TextAlign::Left` and `None`:

```rust
line.paint_background(row_origin, line_height, TextAlign::Left, None, window, cx);
line.paint(row_origin, line_height, TextAlign::Left, None, window, cx);
marked.paint_background(marked_origin, line_height, TextAlign::Left, None, window, cx);
marked.paint(marked_origin, line_height, TextAlign::Left, None, window, cx);
```

That is a small, well-contained migration for the terminal library. The shell
and `spikes/gpui-terminal` still need their own API pass, but the hardest
native surface is not the blocker.

## Current compatibility matrix

| Surface | GPUI 0.2.2 + `gpui-component 0.5.1` | GPUI 0.3.12 + `gpui-kit 0.9.1` |
| --- | --- | --- |
| Components/theme/Root | Yes | Yes, current |
| Markdown/TextView | Yes | Yes, current |
| Virtual list/table | Yes | Yes, current |
| Webview | Wry, experimental | `gpui-webview` (Wry), experimental |
| Accessibility (AccessKit) | **No** | **Yes** |
| UI testing helpers | Limited | `gpui_kit::test` |
| Current maintenance | Old release (v0.5.1) | Current v0.9.1 |
| Terminal library migration | None | 4 paint calls |

## Measurements — track A

Release build, live database (138 in-scope cards), 5 runs, same measurement
script as #322.

| Check | Hand-rolled #322 | gpui-component 0.5.1 |
| --- | ---: | ---: |
| First shell frame | 86.4 ms | **104.8 ms** |
| First LIST frame | 167.4 ms | **209.0 ms** |
| Card model load | 15.2 ms | **6.1 ms** |
| Row flatten/group | 25.7 µs | **28.5 µs** |
| Visible rows | 13 | **13** |
| RSS after load | 76.9 MB | **80.4 MB** |
| Release binary | 9.04 MB | **16.19 MB** |
| Headless scroll median (2,137 cards) | 0.55 ms | **0.76 ms** |
| Headless scroll p95 | 0.92 ms | **1.08 ms** |

Read-only detail probe against live cards (`STACKS_GPUI_OPEN_CARD`):

| Card | Content | Events | Detail open → first frame | Detail DB load | RSS with detail |
| --- | ---: | ---: | ---: | ---: | ---: |
| #322 | 7,092 chars | 11 | **21.0 ms** | 4.1 ms | 95.1 MB |
| #323 | 3,056 chars | 0 | **30.6 ms** | 3.4 ms | 89.1 MB |

The detail surface is rendered by `TextView::markdown` with a real card body and
real event rows. RSS rises while the detail is open; the list-only number stays
around 80 MB.

The component layer costs about **18 ms at first frame**, **42 ms at first LIST
frame**, **3.5 MB RSS** and **7.1 MB binary** in this integration. That is a
reasonable price for ready components, themes, Markdown and future AccessKit;
it is not free.

The 0.9.1 line will add more dependencies (AccessKit, current base/component
layers, possibly webview). Budget for another binary/runtime increase when the
migration is measured.

## Detail verdict

- **Native read-only detail: go.** The read model + GPUI Kit Markdown + tags/
  buttons covers the read-only surface comfortably. Real card content
  (16k+ character cards) is rendered by `TextView::markdown`.
- **Native edit/actions/Pi/DIFF: not decided by this card.** Those remain seams
  to the shipped app. The detail surface exposes copy-reference/open-URL actions
  only; workflow mutation is intentionally absent.
- **Hybrid webview: possible, not required for read-only detail.** `gpui-webview`
  (Wry) exists in current `gpui-kit` and in 0.5.1's optional `webview` feature.
  Embedding the existing React detail would still require serving the Vite
  bundle, a WKWebView child view, an IPC bridge for Tauri invokes, focus/lifetime
  handling and a security boundary. Keep it as the fallback for rich
  editor/chat/diff surfaces, not as the default detail path.
- **Accessibility is the decisive reason to move to 0.9.1.** 0.5.1 has no
  AccessKit. If we build product UI on 0.5.1, we repeat the #322 accessibility
  gap. 0.9.1 is the only version that closes it.

## Recommendation

1. **Adopt GPUI Kit as the UI foundation.** Stop hand-rolling buttons, tags,
   badges, Markdown, overlays and themes.
2. **Do not build more on 0.5.1.** Treat this branch as a compatibility probe.
3. **Migrate to `gpui-kit 0.9.1` + `gpui-pre 0.3.12` next.**
   - update root workspace pins;
   - apply the four terminal paint-signature changes;
   - port shell/list detail to the 0.9.1 Base/Component API;
   - migrate `spikes/gpui-terminal` or temporarily isolate it from the workspace;
   - measure startup/RSS/binary and run the a11y/webview checks.
4. After that migration, re-run the LIST/detail UI polish card on the current kit.
5. Keep card detail native read-only; add mutation/Pi/DIFF as separate decisions.
6. Do not use the webview as a way to avoid the accessibility migration.

## Human input still required

- Visual pass on the component-tinted LIST/detail UI: spacing, density, theme
  fit, Stacks identity versus default kit styling.
- Verify Markdown rendering with real long cards (tables/images/code blocks,
  links, inline HTML) and decide the supported subset.
- Accessibility pass after the 0.9.1 migration.
- Decide whether the shell should use `Root` + kit dialogs/menus or keep the
  native GPUI menu bar.

## Validation performed

| Check | Result |
| --- | --- |
| `gpui-component 0.5.1` compatibility probe on GPUI 0.2.2 | PASS |
| `gpui-kit 0.9.1` minimal compatibility probe on `gpui-pre 0.3.12` | PASS |
| `stacks-terminal` copy on `gpui-pre 0.3.12` | PASS after 4 paint-signature changes |
| `cargo test -p stacks-cards` | PASS: 3 unit + 6 read-model tests |
| `cargo test -p stacks-gpui` | PASS: 14 tests, including detail open/load with real Markdown content, drag reorder, and 2,137-card scroll bound |
| `npm run test` | PASS: 168 files / 1,341 tests, 2 skipped |
| `npm run build` | PASS |
| `cargo test --workspace` | PASS |
| `cargo check --workspace --all-targets` | PASS |
| `cd src-tauri && cargo check` | PASS |
| Live shell launch with GPUI Kit Root/components | PASS: first LIST frame 209 ms, 138 cards, 13 visible rows |
| Live screenshot | BLOCKED by macOS screen-recording permission; component rendering verified through the shell launch, metrics and GPUI tests |
