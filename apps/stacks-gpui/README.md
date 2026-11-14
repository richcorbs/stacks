# Stacks GPUI shell spike (cards #321 / #322)

Single-process GPUI shell with window chrome, native menu/keybindings, two
surfaces:

- **Cards** (`Cmd+L`, default) — the surviving Stacks LIST view, rendered from
  the real SQLite database through `crates/stacks-cards`. Groups/counts/collapse,
  project filter, loading/error/empty states, row metadata, keyboard navigation,
  backlog drag reorder, and a native card detail with tabs for Description,
  Agent, Diff, Terminal, Server and Console. The detail includes a native Pi
  agent, shared terminal panes, services, releases and the workflow action
  footer.
- **Terminal** (`Cmd+T`) — the card #321 global terminal tab set with splits,
  maximize, search, copy/paste, focus, IME plumbing, drag/drop and notifications.

It is **not** the shipped app. Card creation/editing, native DIFF review,
Superthread sync, some settings UI and a few provider-specific workflows remain
Tauri-only. The workflow engine itself is shared through
`crates/stacks-workflow`; native card actions include refinement, start work,
approval, local/target/PR merge, scripted delivery and cleanup. Reports:

- `../../docs/gpui-app-shell-321.md` — shell/terminal spike.
- `../../docs/gpui-list-view-322.md` — LIST product-surface spike.
- `../../docs/gpui-kit-adoption-323.md` — GPUI Kit adoption + native detail
  feasibility.
- `../../docs/gpui-kit-0.9.1-migration-324.md` — migration to `gpui-kit 0.9.1`
  + `gpui-pre 0.3.12`, measurements and remaining accessibility work.
- `../../docs/gpui-workflow-footer-323.md` — shared workflow engine and native
  footer/action parity.
- `../../docs/gpui-native-port-323-decision.md` — cost/benefit verdict and
  go/no-go criteria.
  The app now uses the 0.9.1 foundation.

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

read/write. Override with `STACKS_GPUI_CARDS_DB`. It does not migrate, but the
native workflow actions write card state, events, environments, pull requests
and delivery operations using the shipped schema. Backlog reorder uses the same
`KANBAN_REORDER_CONFLICT` contract as the shipped app.

Useful env switches:

```bash
STACKS_GPUI_START_VIEW=list|terminal  # startup surface (default: list)
STACKS_GPUI_CARDS_DB=/path/workflow.sqlite3
STACKS_GPUI_OPEN_CARD=322  # auto-open a card id/external id on load (detail probe)
STACKS_GPUI_METRICS=1      # first-frame, first-LIST/detail-frame and first-PTY timings
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
or `Space` open detail; `Esc` close detail/clear; `←/→` collapse/expand the
focused group. Detail has parent/child navigation, tab shortcuts, workflow
actions and `Cmd+Enter` for the primary workflow action. Drag Backlog rows to
reorder.

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
STACKS_GPUI_OPEN_CARD=322 npm run gpui-list:measure  # detail-frame metrics
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
