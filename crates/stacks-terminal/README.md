# stacks-terminal

Reusable GPUI + libghostty-vt terminal surface extracted from the card #318
spike (card #321). It is consumed by:

- `spikes/gpui-terminal` — the card #318/#319 demo and adjacent-window host.
- `apps/stacks-gpui` — the card #321 minimal app shell.

Nothing in this crate is imported by the shipped Tauri app.

## Modules

| Module | Responsibility |
| --- | --- |
| `terminal_model` | libghostty-vt lifecycle, frames, selection, search, paste/key/mouse encoding |
| `terminal_surface` | cell metrics, shaped rows, colors, cursor, marked text, `TerminalStyle` |
| `split_tree` | pane tree, split/remove/ratio/relative-pane math |
| `pty` | portable-pty spawn/write/resize, login shell, generation ids, async events |
| `keymap` | GPUI keystroke → Ghostty key/modifier mapping |
| `parity` | xterm.js differential corpus runner |
| `fixtures` | deterministic render fixture used by the visual golden |

Host contract: `../spikes/gpui-terminal/HOST_INTEGRATION.md`.
Shell spike report: `../docs/gpui-app-shell-321.md`.

## Test and parity

```bash
# from the repository root
cargo test -p stacks-terminal
cargo test -p stacks-terminal --test tui_smoke -- --test-threads=1 --nocapture
npm run gpui-shell:parity

# regenerate the model-level visual golden
UPDATE_VISUAL=1 cargo test -p stacks-terminal --test visual_test
./scripts/visual-test.sh
```

The 120 Hz CPU-budget benchmark is opt-in:

```bash
cargo test -p stacks-terminal --release --test bench_120hz -- --ignored --nocapture
```

`parity/` is the xterm.js harness/corpus; see `parity/README.md`. The harness
uses the repository's Vite/Playwright dependencies and serves the repo root.
