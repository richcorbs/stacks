# Split tree and pane kind

Four pane models store the same idea: a split tree of panes with one focused
pane and an optional maximized pane.

| model | storage | owner |
|---|---|---|
| card environments | `card_layouts` + `card_panes` | `kanban/environment.rs`, `kanban/repository.rs` |
| project workspaces | `project_direct_work` + `project_direct_panes` | `project_direct.rs` |
| top-level terminal | `global_terminal_state` | `global_terminal.rs` |
| legacy workspaces | `legacy_workspaces.splits` (0 rows) | `store.rs` |

## One owner per language

- **TypeScript: `src/splitTree.ts`** owns every tree mutation, visual order,
  even distribution, focus/maximize invariant and the persistence signature.
  `src/utils.ts` re-exports the historical names, so `utils.test.ts` stays the
  public contract and existing imports keep working.
- **Rust: `src-tauri/src/split_tree.rs`** owns the layout shape, visual order,
  focus/maximize resolution, the canonical stored layout JSON and `PaneKind`.
  Rust only *reads* layouts: the frontend mutates and persists them, so the Rust
  view deliberately drops ratios and `manual` flags and can never rewrite a
  layout. Do not add a second mutation implementation in Rust; if a Rust caller
  ever needs to mutate a tree, move the maths there and have TypeScript call it.

Focus/maximize/close rules the models must not re-derive:

- visual order is left/top before right/bottom (`collectLeafTerminalIds`)
- automatic splits distribute their same-direction children evenly; a split
  marked `manual` is never rebalanced
- focus always resolves to a leaf of the current tree, otherwise the first leaf
- maximize only resolves to a leaf that is still in the tree
- closing a pane focuses the previous pane in visual order, wrapping to the last
  pane when the first pane closes
- focusing a pane keeps maximize following focus; toggling maximize on an
  already maximized pane restores the split

## Pane kind

`PaneKind` (`shell | pi | server | console`) is the shared classification.
`role()` and `kind()` return the spellings the existing tables already persist
(`shell`/`terminal`, `pi`/`pi`, `server`/`terminal`, `console`/`terminal`), so
the enum changes no storage format. Rust consumers classify panes with
`PaneKind::parse` instead of comparing raw strings.

## Measurement tests

Behaviour is measured, not eyeballed:

- `src/splitTree.test.ts` — property-style over seeded random trees (insert,
  remove, visual order, even distribution, focus/maximize resolution, frozen
  persisted JSON).
- `npm run test:split-tree` (`tests/split-tree.mjs`) — a real
  `WorkspaceShellView` in Chromium and WebKit driven through split, resize,
  maximize, navigate, request/cancel close and close. It compares the layout
  DOM, focus outcomes, session disposal and the Pi composer focus path against
  `tests/fixtures/split-tree-golden.json`, which was generated from the
  pre-extraction behaviour. A change there means behaviour changed; regenerate
  with `UPDATE_SPLIT_TREE_GOLDEN=1` only when the difference is intended and
  explained.
