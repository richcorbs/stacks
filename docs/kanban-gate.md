# One gate and one repair path (card #350)

`src-tauri/src/kanban/gate.rs` is the single evaluation for "is this card blocked?".
It owns the blocker vocabulary, the user-visible copy and the repair that clears each
blocker. Every other consumer reads its verdict.

## Vocabulary

```text
BlockerCode   stable snake_case code + canonical message + affected action + repair
Repair        { id, label, kind: Automatic | NeedsUser, effect }
GateVerdict   codes, blockers, repairs, facts
GateContext   { mode, overrides, runtime_ids }
```

`BlockerCode::ALL` is the reviewable table. Adding an invariant means adding one row
(and a fixture), never a new prose string in a consumer. A blocker cannot exist without
a repair: `GateVerdict::push` takes the repair from the code table, and needs-user
repairs must name the action the human takes.

## Modes

| mode | consumer | what it evaluates |
| --- | --- | --- |
| `Health` | environment banner, `environment_health` | environment, Git, cleanup and projection checks |
| `Action(a)` | `require_structural_capability` | the same verdict, filtered to the action's steps |
| `Retire(m)` | `retirement::evaluate` | the retirement invariant checklist |
| `Retention` | Done retention and the hygiene report | why retention defers this card |

Cleanup keeps its resource inventory (`cleanup_preflight`) but records each reason
through `record_blocker`, so its codes, copy and repairs come from the gate. Hygiene
keeps detection (it scans the whole board) and is the executor for automatic repairs;
its Done-retention findings are just the retention verdict.

## Repairs

Automatic repairs are one click in the environment banner and run through
`kanban_apply_card_repair`:

- `repair_parent_metadata` — clear a stale aggregate flag/count.
- `clear_stale_lifecycle` — delete a Pi lifecycle projection with no running session.
- `cleanup_orphaned_environment` — remove a dead environment via the normal retirement
  path.
- `retry_provider_sync` — drain a queued Superthread update.
- `pull_target_checkout` — fast-forward the clean target checkout to its remote.

Everything else is `NeedsUser`: the banner shows the repair label and effect (for
example "Commit, stash or discard" or "Merge in target & resolve") instead of
pretending a click can decide it. No guard is weakened: retirement overrides and
explicit confirmations still exist, and the action gate deliberately leaves close,
delete and request-changes available so a broken environment never removes the escape
hatch.

## Historical stuck states

| state | code | repair |
| --- | --- | --- |
| finalized flag without children | `finalized_parent_without_children` | `repair_parent_metadata` (automatic) |
| Done card whose worktree is gone | `environment_worktree_missing` | `cleanup_orphaned_environment` (automatic) |
| backfilled `pi_lifecycle` marked active | `stale_lifecycle_projection` | `clear_stale_lifecycle` (automatic) |
| stale primary checkout | `target_checkout_behind` | `pull_target_checkout` (automatic) |
| queued provider sync, attempt 0 | `provider_sync_pending` | `retry_provider_sync` (automatic) |

## Tests

`src-tauri/src/kanban/gate_tests.rs` owns:

- one table over `BlockerCode::ALL` (code stability, copy, repair),
- fixtures for the historical stuck states, asserting the code and repair,
- a fixture per mode asserting no blocker lacks a repair or explicit instruction,
- one scenario asserting the banner, action gating and retention read the same verdict.
