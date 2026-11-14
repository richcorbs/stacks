# Stacks GPUI shell spike (cards #321 / #322)

Single-process GPUI shell with window chrome, native menu/keybindings, two
surfaces:

- **Cards** (`Cmd+L`, default) — the surviving Stacks LIST view, rendered from
  the real SQLite database through `crates/stacks-cards`. Groups/counts/collapse,
  project filter, loading/error/empty states, row metadata, keyboard navigation,
  open-card placeholder and backlog drag reorder.
- **Terminal** (`Cmd+T`) — the card #321 global terminal tab set with splits,
  maximize, search, copy/paste, focus, IME plumbing, drag/drop and notifications.

It is **not** the shipped app. Card detail content, Pi chat, DIFF,
GitHub/Superthread sync, card creation/sync/cleanup and settings UI are not
ported. Reports:

- `../../docs/gpui-app-shell-321.md` — shell/terminal spike.
- `../../docs/gpui-list-view-322.md` — LIST product-surface spike, parity matrix,
  measurements and verdict.

## Run

```bash
# repository root: Cards surface reading the live Stacks database
cargo run -p stacks-gpui

# terminal-first (card #321 shell behaviour)
STACKS_GPUI_START_VIEW=terminal cargo run -p stacks-gpui

# release + one-bundle .app (ad-hoc signed)
npm run gpui-shell:build
npm run gpui-shell:bundle
open "dist-gpui/Stacks GPUI Shell.app"
```

Debug data directory: `~/Library/Application Support/stacks-gpui-dev/`.
Release: `~/Library/Application Support/stacks-gpui/`.
Override with `STACKS_GPUI_DATA_DIR`.

The Cards surface reads:

```text
~/Library/Application Support/stacks/workflow.sqlite3
```

read-only. Override with `STACKS_GPUI_CARDS_DB`. It does not migrate or write
except for backlog reorder, which uses the same `KANBAN_REORDER_CONFLICT`
contract as the shipped app.

Useful env switches:

```bash
STACKS_GPUI_START_VIEW=list|terminal  # startup surface (default: list)
STACKS_GPUI_CARDS_DB=/path/workflow.sqlite3
STACKS_GPUI_METRICS=1      # first-frame, first-LIST-frame and first-PTY timings
STACKS_GPUI_TRACE_FOCUS=1  # activation and key tracing
```

Files written:

- `settings.json` — font family/size/line-height, scrollback, copy-on-select,
  notifications, optional shell override, theme. Edit and relaunch; the settings
  screen is out of scope.
- `shell-state.json` — window origin/size, tab split trees and focused pane.
  Panes restore as fresh shells (cwd/scrollback are not persisted in this
  spike).

LIST filter/collapse/focus are in-memory only in this spike.

## Shortcuts

Cards: `Cmd+L`; refresh `Cmd+R`; `↑/↓` or `j/k` navigate; `Home/End`; `Enter`
or `Space` open; `Esc` close/clear; `←/→` collapse/expand the focused group.
Drag Backlog rows to reorder.

Terminal: `Cmd+T` focus global terminal, `Shift+Cmd+T` new tab, `Cmd+W` close,
`Cmd+D` split right, `Shift+Cmd+D` split down,
`Shift+Cmd+Enter`/`Shift+Cmd+M` maximize, `Cmd+F` search, `Cmd+K` clear,
`Cmd+C`/`Cmd+V` copy/paste, `Cmd+[`/`Cmd+]` tabs,
`Shift+Cmd+[`/`]` panes (`Option+Cmd+[`/`]` alias), `Cmd+1..9` select tab,
`Cmd+,` settings stub, `Cmd+Q` quit.

## Test and measure

```bash
cargo test -p stacks-gpui
cargo test -p stacks-cards
npm run gpui-list:measure                       # Cards startup/memory/binary
npm run gpui-list:fixture -- --cards 2000       # throwaway large database
node scripts/measure-gpui-shell.mjs --runs 5 --start-view list \
  --cards-db /tmp/stacks-gpui-list-2000.sqlite3
npm run gpui-shell:measure -- --start-view terminal
node scripts/measure-gpui-shell.mjs --tauri-app ~/Applications/Stacks.app
```

The measurement script wakes the display with `caffeinate`; GPUI does not paint
an asleep display, which would skip the first-LIST-frame instrumentation. The
Tauri comparison in the #321 report used the running dogfood instance; a fresh
Tauri launch is blocked by its automation single-instance path.
