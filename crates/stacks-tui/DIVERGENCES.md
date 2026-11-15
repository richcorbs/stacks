# Terminal divergences (vt100 backend)

`stacks-tui` renders PTYs through the `TerminalScreen` trait with a `vt100`
backend. The trait is the upgrade seam for `libghostty-vt` (card #318); these
are known differences from xterm/Ghostty, recorded instead of chased.

| Area | Behaviour | Consequence |
| --- | --- | --- |
| Graphics | No Kitty graphics protocol, no sixel, no iTerm inline images | Image output degrades to text/blank cells. Pi/CLI image previews are not visible. |
| Unicode width | Cell width uses `unicode-width` 0.2 and `vt100` cell contents | Ambiguous-width and some grapheme clusters can differ from Ghostty. Combining marks are attached to the preceding cell. |
| Wide cells | `is_wide_continuation` cells are skipped; the wide glyph advances two cells | Double-width CJK generally aligns; unusual emoji ZWJ sequences may not. |
| Mouse | Mouse tracking is deliberately not enabled | TUIs that rely on mouse clicks cannot be driven. Lazygit runs keyboard-only here; lazygit itself still works. |
| OSC 52 | Clipboard yank is written to stdout as OSC 52 | Depends on the outer terminal allowing clipboard writes; no read-back. |
| OSC 8 / titles | Hyperlinks, window title/icon queries are ignored | Links remain plain text; the TUI owns the title. |
| Palette | 256/16-colour approximation when the outer terminal lacks truecolour | Slight colour shifts; status words/glyphs carry meaning independently. |
| Scrollback | 2,000 lines per pane | Longer history is not retained. |
| Reflow | `vt100` resize semantics | Long wrapped lines may not reflow exactly like Ghostty on resize. |
| Bracketed paste | Enabled; pasted bytes are forwarded to the PTY | No destructive-paste confirmation layer. |
| Application cursor | Arrows/Home/End switch to SS3 when the application requests it | Matches xterm for vim/less/readline. |
| Alternate screen | Supported by `vt100` | Pi/vim/less full-screen UIs work. |
| IME | No IME composition inside the TUI | The outer terminal handles IME; xterm.js parity is not attempted. |
