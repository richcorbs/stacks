# GPUI LIST view product-surface spike — card #322

**Question:** can Stacks' surviving **LIST view** be a real GPUI product surface,
or does the native shell need an embedded webview for product UI?

**Answer:** **Go for pure GPUI on LIST; no-go for stopped/blocked migration.**
LIST can read real Stacks data without Tauri, reproduce its groups/counts/rows,
support keyboard navigation and backlog drag reorder, and stay virtualized at
2,137 cards. The remaining migration blockers are card detail and rich product
actions (Pi/DIFF/GitHub/Superthread), not the LIST shell. A hybrid webview is not
required for LIST, but this spike does not justify removing it from the option
space for detail/integration surfaces until those are spiked.

This is the product-surface follow-up to [card #321's shell spike](gpui-app-shell-321.md).
It builds on the uncommitted #321 shell baseline (imported into this worktree)
and uses the same GPUI 0.2.2 / Tauri-free architecture.

## What was built

```text
crates/stacks-cards/             reusable, Tauri-free card read model
  src/model.rs                   card/project/PR/list row types + canonical statuses
  src/workflow.rs                LIST groups, delivery-step projection, filtered reorder
  src/store.rs                   read-only SQLite board read + backlog reorder write
  tests/read_model.rs            real-schema fixture: projection, grouping, reorder conflict
  examples/list_snapshot.rs      print/JSON the live board read model

apps/stacks-gpui/src/list.rs     native LIST surface on top of stacks-cards
  groups/counts/collapse, project filter, refresh/loading/error/empty states
  fixed-height uniform_list virtualization, row metadata, PR/environment badges
  keyboard navigation/focus, open-card placeholder seam
  GPUI drag-to-reorder for Backlog with optimistic update + conflict recovery
```

The shell now has two surfaces: **Cards** (`Cmd+L`, default) and **Terminal**
(`Cmd+T`). `STACKS_GPUI_START_VIEW=terminal` restores the #321 terminal-first
startup for shell measurements.

## Data path

`stacks-cards` opens the shipped database read-only:

```text
~/Library/Application Support/stacks/workflow.sqlite3
```

Override with `STACKS_GPUI_CARDS_DB`. The default is deliberately the shipped
database rather than the GPUI shell's own `stacks-gpui-dev/` directory so the
spike renders real cards. There are no migrations or writes during reads.

The read model queries the canonical tables (`kanban_cards`, `projects`,
`card_environments`, `card_layouts`, `card_pull_requests`) and projects:

- canonical status → LIST group (`Needs your action`, `In progress`, `Backlog`,
  `Done`);
- hierarchy-effective statuses (finalized parents roll up to their earliest
  child status), including parent/child summaries;
- delivery labels from the frontend `deliveryStep` projection;
- persisted PR snapshot + blockers using the backend's CI/approval/revision
  policy;
- environment lifecycle/branch indicator.

The only write is backlog reorder. It replaces the complete canonical
`needs_refinement` lane in one immediate transaction, preserves hidden slots
when a project filter is active, and returns the same
`KANBAN_REORDER_CONFLICT` contract as `kanban_reorder_cards`. It does not run
Tauri workflow transitions, GitHub calls or cleanup.

This is a narrow native service layer, not a full extraction of the Tauri
`src-tauri/src/kanban` module. The projection rules are in Rust, outside GPUI,
but the Tauri app still uses its existing implementation. The shared crate is
the intended seam if a later card extracts the repository wholesale.

## LIST parity matrix

### Reproduced

| Surface | Result |
| --- | --- |
| Group set/order | `Needs your action`, `In progress`, `Backlog`, `Done`, same as React `WORK_GROUPS`. |
| Group counts | Full filtered count per group, including collapsed groups. |
| Collapse/expand | Header click, `←`/`→` on a focused card. Done starts collapsed. |
| Empty groups | `No cards here · <group>` row. |
| Loading | Initial loading screen while SQLite read runs. |
| Error | Load error with database path + Retry; refresh errors keep stale data and show a banner. |
| Project filter | `All projects` + per-project chips with counts; filtering updates groups/rows/counts. |
| Row identity | External id, title, project name/color. |
| Status/delivery | Status-derived delivery label and action-required accent; PR/local-merge/scripted/hierarchy labels from shared projection. |
| Hierarchy | Parent badge (`parent #…`), child count, effective parent/child statuses. |
| PR | PR number + persisted CI state badge. |
| Environment | `! environment` warning when the persisted lifecycle is not `ready`. |
| Keyboard | `↑/↓` or `j/k`, `Home/End`, `Enter/Space` open, `Esc` close/clear, `←/→` collapse. Focused row scrolls into view. |
| Open card | Placeholder detail overlay with a documented seam for native detail/webview. |
| Backlog reorder | GPUI drag preview; drop on a row moves the dragged card before it; optimistic update; persists; conflict reloads authoritative order. |
| Virtualization | `uniform_list` renders only the viewport; row height is fixed. |
| Refresh | `Cmd+R` or header Refresh. |
| Terminal coexistence | `Cmd+L` / `Cmd+T` switch between LIST and the global terminal without recreating terminal sessions. |

### Omitted / gaps (explicit)

| React LIST feature | Status here | Why / follow-up |
| --- | --- | --- |
| Add card, sync, Open Project Workspace, list/board switch | **Omitted** | Board is being removed and new-card/sync/project management are out of scope. Header is now project filter + refresh only. |
| Live Git status badges (`+created ~changed -deleted`, git error) | **Omitted** | Requires `src-tauri/src/git.rs`/repository commands. The model has the worktree path but no live git read. |
| Live environment health/issues + recheck | **Partial** | Only persisted `lifecycle_state != ready` is shown. Issue details/recheck need the Tauri health service. |
| Server service badges/toggle | **Omitted** | Needs process/service ownership and handoff logic from Tauri. |
| PR merge action | **Omitted** | Requires fresh preflight, GitHub CLI and merge/cleanup orchestration. PR badge is display-only. |
| PR freshness (`prChecks`, 180s stale state, refreshing/failed) | **Omitted** | No session refresh coordinator; row shows the persisted snapshot. |
| Done cleanup menu (`Clean up all`) | **Omitted** | Requires done-retention preview/execute, PTY/Pi shutdown and worktree cleanup. A disabled hint points back to Stacks. |
| Assignee/provider-board attribution | **Partial** | Assignees are in the model but not rendered; provider board/attribution row was dropped to keep rows one line. |
| Accessibility semantics (`role`, `aria-label`, `aria-expanded`) | **Gap** | GPUI 0.2.2 has no app-level accessibility tree/roles. Keyboard navigation works; screen-reader parity is not possible without GPUI/platform work. |
| Persistent filter/collapse/focus | **Gap** | State lives in the view. React persists filter/collapse in settings. |
| Drag auto-scroll at list edges | **Omitted** | Drop/reorder works on visible rows; GPUI drag auto-scroll is additional work. |
| Drag overlay fidelity | **Partial** | Native GPUI drag preview shows id/title, not the full React card overlay. |
| Context menus, dropdowns, rich popovers | **Gap** | No shared GPUI primitives in 0.2.2; buttons/chips are hand-rolled. |
| SVG icons | **Gap** | Row indicators use text glyphs; GPUI `svg` requires an asset loader setup. |
| Search/filter text, card detail content, Pi chat, DIFF, GitHub/Superthread sync | **Out of scope** | Per card. Placeholder detail defines the mount seam. |

## Measurements

Method: release build on macOS 15.7.7 arm64, 5 runs for startup/memory, display
awake and unlocked (`caffeinate -u`) because GPUI does not paint an asleep or
locked display.
`scripts/measure-gpui-shell.mjs`; cards were the live Stacks database and a
throwaway copy with synthetic backlog cards from
`scripts/seed-gpui-list-fixture.mjs`.

| Check | Live DB | 2,137 in-scope cards |
| --- | --- | --- |
| Projects / cards | 6 / 137 | 6 / 2,137 |
| First shell frame | **86.4 ms** median | **79.4 ms** median |
| First LIST frame (data rendered) | **167.4 ms** median | **161.3 ms** median |
| Card query / model load | **15.2 ms** median | **21.6 ms** median |
| Flatten/group rows | **25.7 µs** median | **363.2 µs** median |
| Visible rendered rows | **13** | **13** |
| RSS after load | **76.9 MB** median | **80.3 MB** median |
| Release binary | **9.04 MB** | **9.04 MB** |

Scroll measurement is a release-mode headless GPUI layout/prepaint benchmark
over the same 2,137-card model:

| 200 scroll positions, 10 rows apart | Result |
| --- | --- |
| Median layout/prepaint | **0.55 ms** |
| p95 | **0.92 ms** |
| Rendered rows | **20** |

This is not an interactive GPU FPS measurement. Screen-capture and keystroke
automation for the live window were blocked by macOS permissions, so the
interactive scroll/drag feel still needs a human pass. The structural result is
clear: `uniform_list` keeps rendered rows bounded independently of card count.

### Code/effort size

- New Rust read model + tests: ~1,300 lines including tests.
- New GPUI LIST surface + tests: ~1,650 lines.
- No duplicated terminal/split/pane code; LIST is a sibling view.
- The first data frame is dominated by the shell/PTY startup (~80 ms); the
  card query adds ~15–22 ms and flattening is sub-millisecond.

## GPUI API friction observed

| Area | Observation |
| --- | --- |
| Lists | `uniform_list` is a good fit for one-line rows, but every row must be the same height. Group headers are padded to the same height; a two-line row would need a custom list or a fixed taller row. |
| Drag/drop | `on_drag`/`on_drop` works and produced a real reorder in a headless event test. There is no built-in edge auto-scroll or list reorder primitive. |
| Focus/keyboard | Per-view focus handle + `on_key_down` works. The shell must explicitly hand focus between LIST and terminal. No accessibility roles/tree. |
| Async | Background executor + `cx.spawn` made read-only SQLite loading straightforward; no async UI runtime needed. |
| Menus/popovers | Native app menu works. In-app dropdown/context-menu primitives are absent; project filter is a chip row. |
| Icons/SVG | Text glyphs were enough for the spike; production row icons need an asset loader/paint path. |
| Row styling | GPUI flex/text truncation works, but dense two-line metadata rows need explicit sizing and manual hit areas. The list row is intentionally one metadata line + title. |

## Decision

1. **LIST is a viable pure-GPUI surface.** It does not need Tauri invokes, a
   webview, SQL duplication in the UI, or a second runtime.
2. **Keep the read model as a crate.** `crates/stacks-cards` is the reusable
   seam. Do not move SQL into GPUI and do not reimplement workflow transitions
   in the UI.
3. **Backlog reorder is in.** It is a narrow transactional write with the same
   conflict contract; it is not the migration blocker.
4. **Card detail remains a seam.** The placeholder explicitly stops at the read
   model. The next decision is native detail vs. a hybrid webview, not whether
   LIST can render.
5. **Accessibility is the sharpest gap.** A production cutover needs platform
   accessibility work in GPUI or a deliberate webview fallback for users who
   need a screen-reader tree.

## Recommended next steps

- Human pass on live LIST: scroll feel, drag reorder in a filtered project,
  keyboard focus handoff, window activation/Spaces.
- Spike **card detail** next (native vs. hybrid seam), because it carries the
  rich editor/chat/diff/integration surface.
- Decide whether to extract the Tauri `src-tauri/src/kanban` repository into
  `stacks-cards` now or keep this narrow read model until the list surface is
  accepted.
- Add persistent filter/collapse to Rust-owned settings if LIST moves forward.
- Keep IME verification paused per request; LIST has no IME surface beyond the
  existing terminal.

## Validation performed

| Check | Result |
| --- | --- |
| `cargo test -p stacks-cards` | PASS: 3 unit + 5 read-model integration tests, including reorder conflict/idempotence and effective hierarchy statuses. |
| `cargo test -p stacks-gpui` | PASS: 14 tests, including LIST render, keyboard open, real drag reorder with persistence, and 2,137-card scroll layout bound. |
| `npm run test` | PASS: 169 files / 1,406 tests passed, 2 skipped. |
| `npm run build` | PASS (contract checks + `tsc` + Vite). |
| `cd src-tauri && cargo check` | PASS (Tauri crate touched only by the independent-crate exclusion; no app changes). |
| `cargo test --workspace` | PASS: 3+5 card tests, 14 shell tests, terminal/demo suites, 1 ignored 120 Hz manual benchmark. |
| `cargo check --workspace --all-targets` | PASS. |
| `cargo fmt --all -- --check` | PASS. |
| `node scripts/measure-gpui-shell.mjs --runs 5 --start-view list` | PASS: numbers above. |
| `node scripts/seed-gpui-list-fixture.mjs --cards 2000` + measurement | PASS: 2,137-card fixture. |
| Live window screenshot | **BLOCKED by macOS screen-recording permission**; window creation and first-list-frame metrics verified. Human visual pass still recommended. |
| Interactive scroll/drag on live window | **REQUIRES HUMAN** (automation/accessibility permission blocked); headless drag/reorder and scroll-layout tests pass. |

## Run it

```bash
# default Cards surface, live Stacks database
cargo run -p stacks-gpui

# terminal-first (card #321 shell behaviour)
STACKS_GPUI_START_VIEW=terminal cargo run -p stacks-gpui

# another database
STACKS_GPUI_CARDS_DB=/tmp/workflow.sqlite3 cargo run -p stacks-gpui

# measurements
npm run gpui-list:fixture -- --cards 2000
npm run gpui-list:measure -- --runs 5
node scripts/measure-gpui-shell.mjs --runs 5 --start-view list \
  --cards-db /tmp/stacks-gpui-list-2000.sqlite3
```
