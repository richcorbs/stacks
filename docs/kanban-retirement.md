# One retirement path for cards (card #341)

`src-tauri/src/kanban/retirement.rs` is the single owner of "can this card be
retired, and how?". The seven former entry points are now thin mode-selecting
wrappers:

| command | mode | notes |
| --- | --- | --- |
| `kanban_close_card` | `PreserveResources` | stop processes, keep worktree/branch |
| `kanban_retry_runtime_cleanup` | `PreserveResources` | resume the same close |
| `kanban_cleanup_environment` | `RemoveResources` | normal merged cleanup |
| `kanban_cleanup_environment_creation` | `RemoveResources` | explicit "clean up setup resources" |
| `kanban_board_health_cleanup_environment` | `RemoveResources` | orphan-tombstone repair |
| `kanban_clean_up_done_cards` | `RemoveResources` then `DeleteRecord` | 7-day retention sweep |
| `kanban_delete_card` | `DeleteRecord` | local drafts only |

`kanban_preview_done_cleanup` remains a read-only preview of the retention window.

## The invariant checklist

`retirement::evaluate(connection, card_id, mode, overrides, runtime_ids)` is the one
answer. It delegates to `gate::evaluate` (card #350) and maps the verdict into a
`RetirementChecklist`; the gate owns the codes, the copy and the repair offered for
each. Checks run in a fixed order and return a `RetirementBlocker { code, reason }`
using the strings the UI already shows:

1. linked children (an aggregate is not a leaf retirement unit)
2. environment/project ownership
3. shared storage key
4. runtime processes (only when the mode does not stop them itself)
5. worktree registered, clean, on its recorded branch and repository
6. merge proof: ancestry or a merged PR with the exact head revision
7. open pull request
8. unresolved provider/delivery/cleanup operation

`RetirementOverride` is the only way to bypass a check. UI cleanup passes
`RetirementOverride::explicit(cleanup_anyway)`; the global Done discard passes
`RetirementOverride::discard()`.

## Unmerged work is safe to remove

An unmerged source revision is no longer a hard refusal. The checklist reports
`override_available`, and an explicit override writes a Git bundle to
`<app data>/retirement-evidence/<card>-<branch>.bundle` before any destructive Git
effect. The path is inserted into the card history as a `retirement_evidence` event
and recorded in cleanup evidence as `explicit_override_bundle`. A missing branch has
no work left to preserve, so it needs no bundle.

## Setup-command failures keep their evidence

A failing start-work command no longer compensates (deletes) the worktree and
branch. `environment::setup_failed_recovery` records ownership when it can be
proven, sets `recovery_required`, and exposes the in-place retry. Re-running start
work with `explicit_retry` re-runs the same setup command against the same
resources. Compensation is reserved for Git-level failures and the explicit
"clean up setup resources" action (`RemoveResources` / `RemoveCreation`).

## Durable intent

Each call writes exactly one `retire_<mode>` row into the unified operations
journal from card #340:

- `retire_preserve_resources`
- `retire_remove_resources`
- `retire_delete_record`

`operations::begin` is idempotent for a card/kind pair, so a retry resumes the same
intent instead of stacking a second one. A policy refusal is evaluated before the
journal and is an ordinary error. An interruption leaves an in-flight row which
`operations::in_flight_for_card` reports; the underlying feature journals (cleanup,
retention, creation) remain the phase-level resume points.

## Tests

`src-tauri/src/kanban/retirement_tests.rs` pins each historical stuck-card class:

- finalized parent with no children → close allowed and stale flag repaired
- environment whose worktree is gone → tombstone cleared by the shared repair
- unmerged branch with override → recovery bundle written and verified, `-D` branch
  deletion only under override
- dirty worktree → refused with the existing blocker string, resources untouched
- interrupted retirement → same journal row resumed and completed
- retention discard → same checklist, complete override, no policy divergence
