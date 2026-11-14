# xterm.js ↔ libghostty-vt parity harness

This harness replays the same corpus through the current xterm.js terminal and
the GPUI/libghostty-vt model, then diffs the resulting grid state.

## Run

From the repository root (so Vite/Playwright resolve the app's dependencies):

```bash
cd crates/stacks-terminal
./scripts/parity.sh
```

or separately:

```bash
node parity/run.mjs        # emulator/grid parity
node parity/keys.mjs       # keyboard encoding parity
node parity/selection.mjs  # copy/selection formatting parity
node parity/paste.mjs      # bracketed-paste encoding parity
```

Generated runs and reports are ignored; set `PARITY_KEEP=1` to keep the full
`.ghostty-run.json` and `.xterm-run.json` for debugging.

## Corpora

- `corpus.json` — hand-written VT cases: wrapping, SGR styles, 16/256/RGB
  colors, cursor movement, erase/insert/delete, tabs, Unicode widths,
  scrollback, alternate screen, reflow, title/bell/OSC 52, cursor visibility,
  insert mode, origin/scroll region, wide-tail overwrite, regional indicators.
- `corpus-tui.json` — captured real PTY output from vim, less, git log and
  macOS top, stored as base64 `write_base64` chunks.

## What is compared

Per snapshot:

- viewport rows and text
- every cell's text, width (wide/tail), fg/bg color source (default / palette
  index / RGB), bold, italic, faint, underline, strikethrough, inverse,
  invisible
- cursor x/y
- normal vs alternate screen
- scrollbar total/offset
- title, bell count, OSC 52 clipboard payload
- all 256 resolved palette RGB values

## Recorded divergences

`known-divergences.json` holds accepted, explained differences. The harness
fails on any new difference. Current records:

- xterm parks the cursor at the right margin after reflow; Ghostty leaves it
  after the last glyph.
- xterm unicode11 gives each regional-indicator code point width 1; Ghostty
  clusters a flag into one width-2 grapheme.
- xterm exposes the pending-wrap cursor as `x = cols`; Ghostty clamps the
  viewport cursor to `cols - 1`.
- repeated `DECSET 1049` while already on the alternate screen: xterm keeps
  the prior alt buffer, Ghostty clears on re-entry (covered by a minimal case
  and by the exploratory fuzzer).

## Current result

- 26 cases, 98 snapshots
- 0 unknown differences
- 14 recorded divergences
- 38 keyboard cases, 0 differences (Ctrl/Alt/Option, arrows, editing keys,
  function keys, Enter/Tab/Backspace/Escape, application-cursor mode)
- 7 selection cases, 0 differences after applying Stacks' trailing-whitespace
  trim used by copy-on-select
- 6 paste cases, 0 unknown differences, 1 recorded safety divergence: xterm
  passes ESC through paste, Ghostty replaces unsafe controls with spaces
- Stacks/xterm default ANSI palette now matches all 256 resolved RGB values.

## Exploratory differential fuzz

`fuzz.mjs` generates a deterministic corpus of random VT sequences and mixed
resizes:

```bash
node parity/fuzz.mjs
PARITY_FUZZ=1 node parity/run.mjs
```

This is exploratory, not part of the default gate. It has already surfaced two
classes of edge cases:

- repeated `DECSET 1049` while already on the alternate screen: xterm.js keeps
  the prior alt buffer, Ghostty clears on re-entry
- style/background persistence around alternate-screen re-entry and SGR state

Those should be triaged before relying on xterm-style escape-sequence abuse;
normal programs pair `1049h` with `1049l`.
