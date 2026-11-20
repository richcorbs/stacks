# Unified operations journal (card #340)

`src-tauri/src/kanban/operations.rs` owns the durable state for every multi-step card
operation. It replaces eleven independently-shaped journals with one storage contract:

```sql
operations(
  id, card_id, kind, phase, attempt,
  error_code, error_detail,
  payload,                 -- typed JSON, validated on load
  created_at, updated_at, completed_at
)
operation_attempts(
  id, operation_id, attempt, phase,
  started_at, finished_at, outcome, error, detail
)
```

Kinds map 1:1 to the legacy journals:

| kind | legacy journal |
| --- | --- |
| `cleanup` | `card_cleanup_operations` (+ `card_cleanup_evidence`, `card_cleanup_phase_outcomes`) |
| `creation` | `environment_creation_operations` |
| `target_merge` | `card_target_merge_operations` |
| `scripted_delivery` | `scripted_delivery_operations` |
| `provider_sync` | `provider_sync_operations` (+ `provider_sync_attempts`) |
| `purge` | `local_card_purge_jobs` |
| `pi_lifecycle` | `card_pi_lifecycle` (+ `card_pi_lifecycle_events`) |
| `retire_preserve_resources` | card #341 retirement intent (PreserveResources) |
| `retire_remove_resources` | card #341 retirement intent (RemoveResources) |
| `retire_delete_record` | card #341 retirement intent (DeleteRecord) |

## What landed in #340

This card is the foundation step (`1 of 3`), so the storage and resume contract landed
first without changing any feature's behaviour:

- One migration (schema revision **81**) creates the two tables and copies every legacy
  row into it.
- Mirroring triggers keep `operations` in lockstep with the legacy tables on insert,
  update and delete. The legacy tables therefore remain the write surface; features
  need no changes and all existing kanban tests stay unchecked/unchanged.
- Cleanup evidence is stored in the cleanup payload. Cleanup phase outcomes and provider
  attempts and Pi lifecycle events become rows in `operation_attempts`.
- Purge tombstones are the one exception to `card_id` being card-bound: the row keeps the
  original id in `payload.card_id` and the FK nulls the column when the card record is
  deleted, so a pending file purge is still reportable.
- `resume(operation)` is the single phase → action mapping and retry policy.
  Features implement `OperationDriver::apply_phase`; `resume_with` owns loading,
  attempt accounting, failure recording and completion.
- Payloads are `#[derive(Deserialize)]` structs with an explicit `validate()`. An unknown
  kind, a mismatched payload, an unknown phase or an empty required field fails loudly on
  load. `unreadable_operations` reports those rows at startup instead of resuming them.
- `in_flight_for_card(card_id)` is the single union query for "what is in flight here?",
  including operations parked for a human.

## Retiring the legacy journals (card #343)

Card #343 finished the migration. `operations` is now the only physical operation
journal; the eleven legacy names are write-through compatibility views:

| schema revision | retired journal |
| --- | --- |
| 82 | `card_cleanup_operations`, `card_cleanup_evidence`, `card_cleanup_phase_outcomes` |
| 83 | `environment_creation_operations` |
| 84 | `card_target_merge_operations` |
| 85 | `scripted_delivery_operations` |
| 86 | `provider_sync_operations`, `provider_sync_attempts` |
| 87 | `local_card_purge_jobs` |
| 88 | `card_pi_lifecycle`, `card_pi_lifecycle_events` |

Each step is its own `schema_migrations` row and never batches another feature's drop.
The views expose the original column order and an `INSTEAD OF` trigger per write
operation, mapping inserts/updates/deletes onto the typed payload and attempt tables.
Feature code and its behaviour tests therefore stay unchanged.

Two consequences are worth knowing:

- Views cannot carry column defaults or `UNIQUE`/`PRIMARY KEY` constraints, so the
  triggers supply the legacy defaults and preserve the uniqueness guards (one cleanup,
  creation, target merge, scripted delivery or Pi lifecycle operation per card).
- SQLite reports zero changed rows for a view write. The few call sites that used
  `execute`/`changes()` as an optimistic-concurrency check now verify the same
  predicate with an explicit `SELECT EXISTS` first.

The `operations_card_delete` trigger restores the cascade the legacy tables got from
their foreign keys. Purge tombstones and retirement intents still outlive the card, and
purge keeps the original identity in `payload.card_id`.

Purge remains the exception to card-bound state: the card record can be gone while the
pending file purge is still reportable.

## Using it

```rust
let operation = operations::load_operation(&connection, id)?; // typed + validated
let decision = operations::resume(&operation)?;               // single dispatcher
```

For a feature driver:

```rust
impl OperationDriver for CleanupDriver {
    fn apply_phase(&mut self, operation: &Operation, phase: &str) -> Result<PhaseOutcome, String> {
        // Apply exactly one phase. The dispatcher records the attempt and next phase.
    }
}

operations::resume_with(&connection, id, &mut driver)?;
```

## Rehearsal

`migrate_a_database_copy_for_rehearsal` in `operations_tests.rs` runs the real migration
against a copy and prints counts per kind:

```bash
KANBAN_MIGRATE_COPY=/path/to/workflow-copy.sqlite3 \
  cargo test --lib kanban::operations_tests::migrate_a_database_copy_for_rehearsal \
  -- --ignored --nocapture
```

It asserts `integrity_check` is `ok` and `foreign_key_check` is empty before and after,
and prints the per-kind row count. Migration is idempotent: the backfill is an upsert,
the views/triggers are `IF NOT EXISTS`, and each retirement step only runs while its
journal is still a physical table.

A production rehearsal through revisions 81-88 kept every row count equal (cleanup 28,
provider sync 20, Pi lifecycle 28, 237 operation attempts = 166 cleanup outcomes plus 71
provider attempts) and left all eleven legacy names as views.
