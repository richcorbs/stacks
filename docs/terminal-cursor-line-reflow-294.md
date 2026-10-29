# Cursor-line reflow evaluation — card #294

## Decision: retain current behavior

Do **not** enable `reflowCursorLine`. Stacks continues to leave it unset, using
xterm 6.0.0's `false` default. No runtime option, focus, PTY, or lifecycle behavior
was changed. This evaluation is separate from dependency upgrade #292.

The persisted local card and its registered environment were inspected read-only:
worktree `stacks-card-294`, branch
`stacks/card-294-evaluate-xterm-6-cursor-line-reflow-during-termi`.

### Default and implementation inspection

- `src/terminalSessionFactory.ts` does not set the option.
- xterm `src/common/services/OptionsService.ts` sets `reflowCursorLine: false`.
- Its public `typings/xterm.d.ts` explains that shells usually handle this
  themselves. This is a stable option, not a proposed API flag.
- `src/common/buffer/BufferReflow.ts` and `Buffer.ts` skip the wrapped logical
  line containing the cursor in both widening and narrowing paths unless enabled.
  Completed output still reflows. Alternate-screen programs own their screen
  layout/redraw; this is not a general-purpose full-screen resize fix.

### Observed comparison

Locally tested on Apple Silicon macOS with xterm 6.0.0, Chromium and WebKit,
Bash/readline 5.3.20, Vim 9.1, Python 3.15.0.

| Case | Current / false | Proposed / true |
| --- | --- | --- |
| Long active ASCII command, no shell redraw | Cursor-containing wrap group is left alone | Consolidates on widening; rewraps on narrowing |
| CJK, emoji, combining accent on active command | Same shell-owned behavior | Reflows content correctly in isolated VT fixture |
| Real Bash input after SIGWINCH | Input retained after shell redraw | Same input; no demonstrated improvement |
| Previously cancelled command above active Bash input | Retained | **Disappears during resize/redraw in the reproduction below** |
| 70 wrapped completed history records | Logical contents retained, reader remains scrolled back | Same |
| Real Bash-generated history | Records retained; reader remains scrolled back | Same for tested records |
| Alternate-screen VT fixture and real Vim | Screen redraw and return to normal buffer pass | Same |
| Split widths, maximize/restore, focus, cached host remount | Pass | Pass |

Reproduction of the reason not to enable globally:

1. Start clean interactive Bash in a PTY at the fitted 500px pane size.
2. Type `echo ` plus twelve repetitions of `abcdefghijklmnop` (do not execute).
3. Resize host 500 → 1000 → 300 → 500px, notifying the PTY of each fitted size;
   exercise centralized focus and host remount at each step.
4. Ctrl-L redraw, then Ctrl-C, leaving the cancelled command in terminal history.
5. Type `echo ` plus thirty repetitions of `世界🙂é`; repeat the resize sequence.
6. Before Ctrl-L, inspect the normal buffer. With false, the earlier command ending
   in `^C` remains; with true, it is absent. Reproduced in both browser engines.

The PTY comparison asserts this difference deliberately: a future xterm/readline
change that invalidates it should trigger re-evaluation, not silent adoption.
It checks current input **before and after** an explicit readline Ctrl-L redraw.
Readline inserts padding spaces at some wide-character margins; the native input
comparison ignores ASCII spaces, while the isolated Unicode fixture checks exact
logical content. These are complementary checks, not byte-perfect native rendering
claims.

A probe using macOS's old `/bin/bash` also found an ASCII resize artifact with the
**current false setting**, before completing the comparison. This is not evidence
that enabling reflow fixes it. The reproducible PTY suite requires Bash 5+ rather
than treating different readline implementations as interchangeable. No shell or
system configuration was modified.

## Regression coverage and ownership

- `tests/terminal-reflow.{html,ts,mjs}` uses the real production session factory,
  addons, cached-session map, `fitSessionPreservingBottom()`, and centralized focus.
  It compares unset, explicit false, and true, asserts unset/false equivalence,
  exact logical Unicode content when enabled, completed history, reader position,
  alternate-screen redraw, and cached identity/buffer retention across host moves.
- Width sequence 500 → 1000 → 300 → 500px models maximize, narrow split and restore.
  Two real terminals exercise focus changes. The PTY suite also checks that a
  zero-width hidden terminal cannot steal focus while maximized.
- `tests/terminal-reflow-pty.{mjs,py}` connects real clean Bash and Vim to browser
  xterm through a disposable Unix PTY; `TIOCSWINSZ` drives actual SIGWINCH redraws.
  Vim enters its alternate screen, receives Unicode input, redraws at every size,
  and exits without saving. No user startup files, vimrc, swap or history files
  are loaded/written by the final harness (`HISTFILE` and `INPUTRC` are `/dev/null`).
  The helper shuts down its foreground process group/shell.
- The card calls the focus API `focusPaneSession()`. This checkout's corresponding
  existing API is named `focusTerminalSession()` in `src/terminalSessionManager.ts`.
  Tests call that API, never ad hoc `term.focus()`. No rename/refactor was needed.
- No React mount owns terminal disposal; no PTY generation or streaming decoder
  logic changed. A host remount is simulated by replacing its DOM node and moving
  the existing terminal element, not by constructing a new session.

## Running and validation

```sh
npm ci
npx playwright install chromium webkit
npm run test:terminal-reflow
# Optional Unix PTY integration; needs Python 3, Bash 5+, Vim, and UTF-8 locale:
REFLOW_TEST_SHELL="$(command -v bash)" npm run test:terminal-reflow-pty
```

Implementation side effect: early PTY probes ran before `HISTFILE=/dev/null` was
added, and evaluation markers were subsequently found in `~/.bash_history`.
The final harness isolates history. With user approval, the 24 probe entries
(exact adjacent history-generator/Vim command pairs) were subsequently removed;
all 132 other history lines were preserved byte-for-byte.

The deterministic browser comparison runs in CI alongside the existing dependency
smoke test. The PTY comparison is opt-in because shell/readline versions and local
Unix tools affect it (the stock macOS Bash is too old for this fixture).

Passed locally:

- `npm run test`: 160 files, 1,281 tests.
- `npm run build`.
- `cargo check` in `src-tauri`.
- `npm run test:terminal-reflow`: Chromium and WebKit, all three option modes.
- `npm run test:terminal-reflow-pty`: both engines, false and true, real Bash/Vim.
- `npm run test:terminal-dependencies`: both engines, all existing smoke checks.

## Limits / future adoption gate

This does not install, restart, or drive the native Stacks app, use its Rust PTY
transport, test a real React split-tree transition, or certify every shell/TUI.
The browser harness exercises the real fit/focus/cache operations underneath those
transitions, with deterministic geometry; the PTY harness uses Python's PTY rather
than portable-pty. No native-app smoke test is claimed.

There is sufficient evidence to retain the existing default without exposing a
new setting. Before reconsidering true, fix/retest the history-loss reproduction,
then manually compare the user's configured zsh prompt/plugins and Bash, cursor
editing in long Unicode commands, scrolled-back output, Vim/less/tmux, actual split
dragging, maximize/restore, workspace focus changes and React remounts in a native
dev build. Seek approval before replacing/restarting the installed dogfood app.
