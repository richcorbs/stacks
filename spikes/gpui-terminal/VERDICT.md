# Verdict: GPUI 0.2.2 + libghostty-vt for the Cmd+T global terminal

**Status: technically viable for the terminal surface, not yet a replacement
for the Tauri app.**

> **Update (card #321):** the reusable modules now live in
> `crates/stacks-terminal`, and `apps/stacks-gpui` is the minimal app-shell
> spike. Verdict on the shell migration: `docs/gpui-app-shell-321.md`.

Toolchain: Rust 1.99.1, Zig 0.17.0, arm64 macOS, `gpui` 0.2.2,
`ghostty-vt` 0.8.0 pinned to Ghostty `1.4.0-main.83fb956`.

## What libghostty-vt gave us for free

- Correct VT parsing and terminal state, including alternate screen.
- Primary-screen reflow on resize; alternate screen stays put.
- Truecolor, 256-color, styles, inverse/faint/underline/strikethrough.
- Grapheme clustering and Ghostty's Unicode width tables (wide/spacer cells).
- Scrollback with viewport scrolling.
- `render.h` state: rows, cells, cursor, palette, dirty tracking, row ids.
- Key encoder with legacy and Kitty keyboard protocol.
- Mouse encoder (X10/UTF-8/SGR/urxvt), focus reporting, bracketed paste.
- OSC 52 clipboard writes, title changes, bell events (queued, no callbacks).
- Stacks' existing PTY approach drops in unchanged: `portable-pty`, generation
  ids, interactive login shell, resize.

That is a large amount of behaviour we did **not** have to write or maintain.

## What we had to write

- PTY lifecycle and the foreground/PTY thread bridge (~180 lines).
- A safe-to-render `Frame` materialization from `render.rs` (~250 lines).
- GPUI window, tab chrome, tab lifecycle, focus, Cmd+T handling.
- Reusable split-tree model, split panes, pane focus/maximize/close routing.
- Reusable terminal surface: cell metrics, shaped rows, cursor and marked text.
- Incremental scrollback search and search overlay.
- Keystroke mapping and the IME/plain-text routing split.
- Selection creation/formatting and copy-on-select.
- Scroll wheel viewport routing, paste, OSC 52 clipboard delivery.
- Host hand-off contract (`HOST_INTEGRATION.md`).
- Test harness, TUI smoke tests, visual golden, benchmark.

The GPUI rendering layer is the part with real long-term cost: a production
terminal wants a monospace glyph atlas and damage-region drawing instead of
reshaping whole rows every dirty frame.

## Evidence

| Acceptance item | Result |
| --- | --- |
| `vim` | PASS: real PTY, alternate screen, Unicode insert, restore primary |
| `less` | PASS: real PTY, long output, alternate screen, quit restore |
| `git log` | PASS: real PTY, rendered grid rows |
| `htop` | NOT RUN: not installed on this machine |
| 256/truecolor | PASS: direct frame assertions + visual golden |
| Resize/reflow | PASS: primary reflow, alternate no-reflow, wide-at-margin |
| No missed/duplicated input | PASS in live app: automated key events echoed exactly once over the PTY; human-confirmed general typing |
| IME | WIRED, NOT VERIFIED BY A HUMAN |
| Ctrl+C / Option combinations | PASS against Ghostty's key encoder; not diffed against a Ghostty binary |
| Copy-on-select / OSC 52 | PASS at model level; clipboard integration wired |
| Bracketed paste | PASS (mode 2004 wraps; unsafe newlines convert to CR) |
| Title / bell | PASS: events surface and update tab/toast |
| Split panes | PASS: split tree tests; live Cmd+D / Shift+Cmd+D create panes; close/maximize/focus wired |
| Search | PASS: live `Cmd+F`, incremental scrollback matches, next/previous, selected-match highlight |
| Host hand-off | PASS: reusable model/surface/split/pty/keymap modules + `HOST_INTEGRATION.md` |
| 120 Hz typing/scrollback | CPU p95 **136–142 µs/frame** over 1200 dirty frames across runs, budget 8.33 ms; GPU present/frame pacing not measured |
| Visual screenshot golden | Model-level SVG/PNG golden; gpui 0.2.2 has no `visual_test` API |
| xterm.js grid parity | PASS: 26 cases / 98 snapshots, 0 unknown differences, 14 recorded divergences |
| xterm.js key encoding | PASS: 38 cases, 0 differences |
| xterm.js selection formatting | PASS: 7 cases, 0 differences |
| xterm.js bracketed paste | PASS: 6 cases, 0 unknown differences, 1 recorded safety divergence |
| Stacks/xterm palette | PASS: all 256 resolved palette RGB values match |

Benchmark command:

```bash
cargo test --release --test bench_120hz -- --ignored --nocapture
# frames=1200 mean=140.62µs p50=140.458µs p95=141.625µs p99=145.792µs max=158.708µs (range p95≈136–142µs)
```

## Parity harness

`./scripts/parity.sh` replays a shared corpus through xterm.js and
libghostty-vt. Current result:

- 26 cases, 98 snapshots, 0 unknown differences, 14 recorded divergences.
- Real PTY transcripts for vim, less, git log and macOS top are included.
- 38 keyboard cases (Ctrl/Alt/Option, arrows, editing keys, function keys,
  application-cursor mode), 0 differences.
- 7 copy/selection cases, 0 differences after Stacks' trailing-whitespace trim.
- 6 paste cases, 0 unknown differences. Ghostty intentionally strips unsafe
  control bytes; xterm passes them through, so that one is recorded.
- All 256 resolved palette RGB values now match xterm.js' default palette.

The recorded differences are listed in `parity/known-divergences.json`:
reflow cursor placement, regional-indicator flag width, xterm's pending-wrap
`x = cols` cursor, and repeated alternate-screen entry. They should be resolved
or accepted by product decision before migration. An exploratory fuzzer is
included but not part of the gate; it still finds style/alternate-screen abuse
cases.

## Divergences and risks

- **Width tables:** CJK/emoji/combining marks agree, but xterm unicode11 and
  Ghostty disagree on regional indicators (one wide flag vs two narrow code
  points). The harness records this instead of hiding it.
- **Reflow cursor:** xterm and Ghostty place the cursor differently after
  wrapping/reflow. The rendered text matches; cursor placement does not.
- **Pending wrap:** xterm reports the cursor one column past the last cell;
  Ghostty clamps it to the viewport.
- **Kitty keyboard protocol:** xterm.js has no Kitty protocol implementation, so
  the key parity suite covers legacy + application-cursor encoding. Ghostty's
  Kitty encoder is exercised by unit tests but cannot be diffed against xterm.
- **Glyph shaping:** CJK and emoji render through GPUI's fallback fonts.
  Monospace fallback can shift columns; ligatures and combining marks are the
  fragile area. Grid/attribute parity is strong; pixels are not yet compared.
- **IME:** marked text is rendered at the cursor, commit goes to the PTY, but
  composition and candidate-window positioning need hands-on testing with the
  actual input method.
- **Visual testing:** gpui 0.2.2 does not ship Zed's visual test platform. The
  golden is a render-model golden, not a GPU screenshot. This is the weakest
  part of the acceptance evidence.
- **Mouse/selection:** copy-on-select and terminal mouse reporting are wired,
  but double-click word select, block select, link opening and autoscroll are
  not at parity with xterm.js.
- **Splits:** implemented in the spike, but there is no draggable divider yet.
  The tree/model supports manual ratios; the host card must add the handle.
- **Search:** synchronous on the GPUI thread; a large-scrollback host should
  drive libghostty-vt's `Search::feed/tick` incrementally.
- **Production wiring:** still absent. The branch does not change the shipped
  Tauri terminal; `HOST_INTEGRATION.md` is the bridge for the convert-rest card.

## Card #319 adjacent-window follow-up

Card #319 ran this surface next to the Tauri app behind
`STACKS_NATIVE_GLOBAL_TERMINAL=1`. The emulator/PTY/renderer survived the host
boundary unchanged; the new cost is app activation, nested-bundle packaging, and
IME verification. The go/no-go verdict and manual checklist live in
`docs/native-global-terminal-319.md`. Short version: keep experimenting, do not
ship a second native surface, and prefer a GPUI app-shell spike over hardening
the two-app seam.

## Recommendation

Continue the native experiment, but keep it behind the spike boundary. The
emulator, PTY, split tree, terminal surface, search, key/selection/paste parity,
and palette are now reusable and documented in `HOST_INTEGRATION.md`. The next
card can consume those modules instead of rebuilding the terminal. The remaining
work is host-shell integration, draggable split handles, GPU glyph/damage
rendering, IME verification, and a real GPU screenshot harness. Do not start a
Tauri replacement from this result alone; use the host contract to scope the
convert-rest card.
