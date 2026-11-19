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

The legacy tables are deliberately still tables in this step. The migration tests that
drop and recreate them are part of the behavioural contract, and card #340's validation
requires the existing kanban tests to pass unchanged. Follow-up work can move each
feature's reads to this module and drop its journal in its own migration step, exactly as
the card's plan prescribes.

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

It asserts `integrity_check` is `ok` and `foreign_key_check` is empty before and after.
Migration is idempotent: the backfill is an upsert and the triggers are `IF NOT EXISTS`.
