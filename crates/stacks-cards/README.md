# stacks-cards

Reusable, Tauri-free read model for Stacks' surviving **LIST** surface.

It opens the shipped `workflow.sqlite3` read-only, projects canonical cards into
LIST rows/groups, and owns the narrow backlog reorder contract. The GPUI shell
in `apps/stacks-gpui` renders this crate; it must not add SQL or duplicate
workflow presentation rules.

```rust
use stacks_cards::{CardStore, WorkGroup, group_cards};

let store = CardStore::default_store();
let snapshot = store.load_snapshot()?;
for group in WorkGroup::ALL {
    println!("{} {}", group.label(), group_cards(&snapshot.cards, group, &snapshot.projects).len());
}
# Ok::<(), anyhow::Error>(())
```

Default database: `~/Library/Application Support/stacks/workflow.sqlite3`.
Override with `STACKS_GPUI_CARDS_DB`.

Read-only reads never migrate. The only write is `reorder_backlog(expected,
card_ids)`, which validates the complete `needs_refinement` lane and returns a
`KANBAN_REORDER_CONFLICT` error on stale order, matching the Tauri command.

Print the live projection:

```bash
cargo run -p stacks-cards --example list_snapshot
cargo run -p stacks-cards --example list_snapshot -- --json
```

See `docs/gpui-list-view-322.md` for the card #322 spike report, parity matrix
and measurements.
