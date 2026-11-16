# Stacks TUI (card #325)

`stacks-tui` is a keyboard-only terminal client for Stacks. It reads and writes
the same `workflow.sqlite3` and `settings.json` as the shipping Tauri app and is
intended to be a peer client, never a second writer while another Stacks owns
the automation socket.

## Layout

```
Cargo.toml                     workspace root: src-tauri + crates/*
crates/stacks-core/            Tauri-free product services
  src/workflow.rs              canonical workflow transitions/capabilities
  src/model.rs                 card/project/detail projections
  src/store.rs                 SQLite read model + workflow writes
  src/grouping.rs              LIST groups, delivery labels, backlog order
  src/diff.rs                  changed files + unified diff parsing
  src/pty.rs                   portable-pty lifecycle
  src/terminal.rs              TerminalScreen trait + vt100 backend
  src/pi.rs                    native Pi launch + optional RPC client
  src/automation.rs            automation.sock card tools + Pi lifecycle
  src/settings.rs              settings.json read/patch
  src/paths.rs                 shipped data-dir resolution
crates/stacks-tui/             ratatui/crossterm binary
  src/main.rs                  args, run loop, automation host
  src/app.rs                   state machine + key dispatch
  src/render.rs                frame composition, minimum size guard
  src/keys.rs                  key vocabulary + the help table
  src/screens/                 board, detail, chat, diff, terminal, ...
  src/widgets/                 text input, tabs, markdown, diff renderer
```

`cargo tree -p stacks-core` contains no `tauri`; the Tauri shell remains an
independent workspace member with unchanged paths, so `cd src-tauri && cargo
check` still works.

## What works

- Board: project sidebar, four product groups (`NEEDS YOUR ACTION`, `IN
  PROGRESS`, `BACKLOG`, `DONE`), hierarchy indentation/collapse, filters,
  project scope, hide-Done, backlog reorder (`J`/`K`). Section headers are
  focusable and collapse with `Enter`; the selected card has a second line for
  branch, Git status and PR state.
- Card detail: real content/events, revision and environment header, backend
  `capabilities` footer in backend order with verbatim disabled reasons,
  two-step confirmation with the configured delay, Overview/Agent/Diff/
  Terminal tabs plus Server and Console when the project configures them.
- Agent: **native Pi TUI in a managed PTY** (`pi --continue` with the
  bundled Stacks extension). Pi's card tools work because the TUI serves
  `automation.sock` (`createLocalCard`, `updateLocalCard`,
  `finishLocalCardRefinement` including approved children, `startLocalCardWork`,
  `agentLifecycle`).
- DIFF: lazygit-inspired collapsible, compressed file tree with per-file
  status and file counts; branch/ahead-behind/dirty/HEAD review context;
  unified diff with reviewed marks (session state, like the GUI), `n`/`p`,
  `[`/`]`, `gg`/`G`, `h`/`l` fold, syntect line
  highlighting and a sticky hunk header. `c` comments on the selected file,
  `C` writes overall feedback, and `s` composes the GUI prompt format and sends
  it to the Agent Pi composer.
- Lazygit is **not embedded**. Its useful UI patterns (tree compression,
  bordered panels, review context) are reused; staging/commit/branch UI stays
  a terminal tool, not a Stacks feature.
- Terminal: real PTY + vt100 rendering, split panes (`Ctrl-W |/-o x z`), exact
  per-pane PTY resize, copy mode (`Ctrl-W [`), OSC 52 yank.
- Global terminal: `Ctrl-G`, `Ctrl-]` to release input and use `n`/`x` for
  tabs.
- Command palette (`Ctrl-P`/`:`), project switcher (`Ctrl-O`), settings
  (`Ctrl-,`) written through to `settings.json`, generated help (`?`).
- Headless verification:
  - `stacks-tui --dump-screen [--cols 120 --rows 40]`
  - `stacks-tui --script keys.txt [--db path]`
  - script commands: `key <token>`, `type <text>`, `paste <text>`,
    `wait <ms>`, `resize <cols> <rows>`, `dump`,
    `assert contains|not-contains|empty <text>`.
- Minimum terminal 100×30; below that a centered message keeps state.
- No mouse handlers and no image rendering.

## Phase 1 status (important)

This card originally asked for a mechanical move of `src-tauri/src/**` into
`stacks-core` before building the TUI. That wholesale move is **not** complete,
but real modules now live in core and both hosts consume them.

Extracted so far (Tauri keeps thin `#[tauri::command]` adapters where needed):

- `paths` / data locations, including the production-copy guard
- `settings_model`
- `pty_command`, `process_group`
- `repository_coordinator`
- `pi_paths` discovery
- `git` repository/diff/worktree implementation (17 moved tests)
- `github` gh/PR/CI implementation (moved tests)
- **the canonical `workflow` engine** — `src-tauri/src/kanban/workflow.rs` is
  now a re-export of `stacks_core::workflow`, so transitions, capabilities,
  lifecycle rules and status metadata are single-source for both hosts
- `global_terminal` and `project_direct` database operations/validation
- `release` policy/config/process execution
- `open` editor/URL helpers

Shell adapters take a profile-aware `CardStore`, so a debug Tauri app still
uses `stacks-dev` while the TUI uses shipped production data.

Still Tauri-owned:

- the `kanban` repository internals (cards, environments, delivery, cleanup,
  provider sync, retention)
- `store`, `settings`, `pty`, `pty_cwd`, `pi_rpc`, `superthread`,
  `workspace_setup`, `app_idle`, `database_backup`, `dev_seed`, `automation`,
  menu/window code
- the card #322 `stacks-core` read/write model remains a parallel projection
  until the kanban repository is moved.

Consequence: the TUI has no `tauri` dependency, and shared modules cannot
drift between hosts, but the kanban repository/workflow still has two
implementations. The next extraction step is the `src-tauri/src/kanban`
repository and its dependent services, then deleting the parallel projection.

## Lazygit investigation

I read lazygit 0.66.2’s source (`pkg/gui/presentation/files.go`,
`pkg/gui/filetree`, the main-view/diff controllers and config docs) and used
what translates cleanly to ratatui:

Adopted:

- **Compressed, collapsible file tree**: lazygit’s `CompressionLevel` /
  single-child directory folding, `▼`/`▶` arrows, per-directory file counts,
  and visual-depth indentation. Our DIFF now has `h`/`l`/`Enter` folding.
- **Review context**: branch, ahead/behind, target, dirty/conflict state and
  the HEAD subject, analogous to lazygit’s Status/commit context.
- **Panel framing**: bordered sections with titles/counts and focused-border
  accents, plus horizontal section rules for detail bodies.
- **Panel framing**: bordered sections with titles/counts (`PROJECTS 6`,
  `CARDS · Stacks · 39`, `FILES 58`, `DIFF · path`), focused-border accents,
  and inline section rules separating the detail body from the footer.
- Existing shortcuts already matched lazygit’s model: context-sensitive footer
  hints, `?` help, confirmation panels, hunk navigation, panel focus, theme
  tokens.

Deliberately not adopted:

- Mouse handling (Stacks TUI is keyboard-only by requirement).
- Lazygit’s command log overlay, config/keybinding file and commit graph; they
  are git-workflow UI for a git client, while Stacks is a card/agent client.
- Embedding lazygit or reimplementing line-level staging. Staging/commit/branch
  operations remain a separate terminal tool, not part of Stacks.

## Native Pi decision

The card's original Chat screen specified a custom transcript/composer over Pi
RPC. After confirming Pi exposes `agent_start`/`agent_settled` to extensions,
the TUI instead runs Pi's native TUI in a PTY, which provides the full Pi
experience (models, slash commands, extension UI, tool rendering) with no RPC
protocol drift. Lifecycle is reported by `src-tauri/resources/stacks-cards.ts`
through the automation socket as `agentLifecycle`.

This is a deliberate scope change from the card text:

- The custom transcript/tool-collapse/queued-message UI is replaced by Pi's own
  TUI. `crates/stacks-core/src/pi.rs` retains an RPC client for future
  headless/automation use, but the TUI does not use it.
- The shared extension now emits lifecycle for card sessions. The shipping GUI
  ignores the unknown automation action; it still infers lifecycle from RPC.
- `Ctrl-]` leaves Pi, shell, service and global-terminal input for normal
  mode; global-rail shortcuts work there.

## Known gaps / follow-ups

- Full `src-tauri` → `stacks-core` extraction (above).
- Superthread provider refinement/credential work, custom start-work setup
  commands, environment-creation cleanup, PR freshness/merge preflight parity.
- Diff tree is lazygit-inspired but not lazygit: no line staging from the
  Stacks DIFF pane.
- Reviewed marks are per-session (the GUI also keeps them in session state).
- Leaving a card stops its TUI terminal/Pi panes; there is no per-card session
  cache yet (the GUI caches per workspace/card).
- Kitty/sixel/inline image output degrades to text (see `DIVERGENCES.md`).
- The automation socket accepts the card-tool subset Pi needs. Superthread
  refinement (`finishExternalCardRefinement`) and parent reassignment remain
  GUI-only and return explicit errors.

## Showcase / demo

A reproducible screen walkthrough lives in
`crates/stacks-tui/examples/demo-screens.script`. It opens the real board,
palette, project picker, card #325, backend actions, DIFF, a real PTY, the
native Pi pane, the global terminal, and help.

```bash
# Copy the live DB so the demo cannot write to the real one.
sqlite3 "$HOME/Library/Application Support/stacks/workflow.sqlite3" \
  ".backup '/tmp/stacks-demo.sqlite3'"
# Pi chat history is JSONL under cards/<card>/pi-sessions. Copy it when you
# want the native Agent pane to resume existing conversations.
rsync -a "$HOME/Library/Application Support/stacks/cards/" \
  /tmp/stacks-tui-demo-data/cards/
mkdir -p /tmp/stacks-tui-demo-data
printf '{"tui_confirmation_delay_ms":0,"tui_hide_done":false}\n' \
  > /tmp/stacks-tui-demo-data/settings.json
# Pi session JSONL files hold chat history; copy them with the DB so the
# the native Agent pane resumes existing conversations.
rsync -a "$HOME/Library/Application Support/stacks/cards/" \
  /tmp/stacks-tui-demo-data/cards/

STACKS_TUI_DATA_DIR=/tmp/stacks-tui-demo-data \
STACKS_TUI_DB=/tmp/stacks-demo.sqlite3 \
PI_PATH="$PWD/crates/stacks-tui/examples/fake-pi-demo.sh" \
cargo run -p stacks-tui -- \
  --script crates/stacks-tui/examples/demo-screens.script --cols 140 --rows 45
```

The interactive path was also exercised through a real PTY with a vt100
emulator (`pyte`): board, help, palette, project picker, settings, filter,
card detail, DIFF, a shell command, the native Pi pane, the global terminal,
and quit all passed. A headless script also created a card and finished its
refinement through the backend action, moving it from Needs refinement to
Ready.

## Validation

```
cargo test -p stacks-core -p stacks-tui
cargo check --manifest-path src-tauri/Cargo.toml
cargo test -p stacks
npm test
npm run build
cargo tree -p stacks-core -e normal   # no tauri
```
