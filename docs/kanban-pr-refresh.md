# Kanban PR refresh scheduling

The board's local Git/health cycle remains at 30 seconds. GitHub reads are in-memory only, keyed by card, project/repository path and delivery settings, workflow revision/status, environment id/revision/path/branch/target and PR number/state. A new/changed identity or explicit refresh runs immediately; unchanged active cards are checked at most once per 60 seconds, other foreground cards once per 180 seconds. Background cycles skip GitHub; returning to the foreground checks overdue cards immediately. Failures retry automatically after 15–120 seconds with deterministic per-card jitter. There is no persistent cache, extra timer or Pi/model request. One coordinator cycle at a time; at most two PR reads in parallel, active card first. Merge continues to run a separate backend `refresh_pull_request` before checking blockers and merging, regardless of the UI badge.

## Reproducible baseline / estimate

`src/kanban/prRefreshSchedule.test.ts` simulates a foreground board with ten unchanged eligible PR cards and ten 30-second ticks (five minutes, ticks at 0..270s), with a fake clock and fake `gh` invocation counter. Before scheduling: 10 × 10 = **100** `kanban_refresh_pull_request` calls, each invoking at least one `gh pr list` (occasionally also `gh pr edit`). After: **20** calls (at t=0 and t=180s). The local/health calls are unchanged. This counts minimum `gh` subprocesses, not a real GitHub network benchmark; real execution time and rate limits depend on authentication, API latency and backend serialization. In dev builds the console logs `[kanban-pr-cycle]` eligible/request counts and `[kanban-pr-refresh]` elapsed milliseconds and failure flags without arguments, credentials or response data. To compare wall time on a representative board, record these entries for five minutes in a foreground session, including failed calls, then compare against the 100-call baseline; no representative live PR board is supplied by the test fixture.

The badge displays check age (or refreshing/retrying) and suppresses a green icon when the read failed or is stale. This is informational only; backend policy controls actions.

## Transaction boundary (card #267)

All PR refresh callers (scheduled/explicit reads, create discovery, merge preflight, and cleanup evidence) now capture a consistent read snapshot, release the connection, run `gh pr list` and optional title normalization outside the board mutation, then apply in a guarded `with_board_mutation`. The compare-and-swap identity covers card/provider/project identity, record/workflow revisions, project configuration revision/path/workflow/target/policy/provider binding, feature-environment flag, environment identity/path/branch/revisions/lifecycle, and the existing PR repository/number/state/head. Changed or deleted identities reject successes and discard delayed failures without events or revision increments. A changed origin remote is also rejected. An unrelated card edit does not invalidate a refresh.

Merge still refreshes independently of UI badges, checks structural capability and all backend blockers in the mutation, and calls GitHub with `--match-head-commit`. Observed merges still use the existing workflow transition and provider outbox. PR creation persists `pr_created` before the independent refresh; a failed refresh leaves that retry evidence, and retry discovers an existing open PR before pushing/creating again. No new cache, automatic retry loop, schema, or provider-field ownership is introduced. Push/create/merge/delete external effects retain their existing transaction boundaries; this change specifically removes refresh/list/edit latency.

### Controlled measurements

Run `cd src-tauri && cargo test kanban::github_delivery::tests -- --nocapture`.
The baseline test reproduces the former `BEGIN IMMEDIATE → external wait → persist` boundary with a controlled 200 ms wait, and verifies that another SQLite writer is blocked. The new test holds an injected GitHub call pending, commits another card edit on a separate connection, then releases GitHub and persists success/failure. Example local results:

| Scenario | Writer hold (including hydration) | Request-to-update |
| --- | ---: | ---: |
| Old boundary, simulated 200 ms GitHub | 207 ms | 207 ms |
| New boundary, delayed success | 2.3 ms | 220 ms |
| New boundary, delayed failure | 2.0 ms | 218 ms |

The concurrent unrelated edit completed in 2–4 ms before GitHub was released. These are controlled backend measurements, **not live GitHub or rendered UI click measurements**. Total refresh latency still includes GitHub latency; the improvement is eliminating writer contention. The tests also cover stale heads, delayed failures, changed project/environment identities, malformed/empty responses, title edits, creation retry evidence, and idempotent observed merges.

For a live comparison, launch Stacks with `STACKS_PROFILE_KANBAN=1` to log mutation lock wait/work-hold and backend refresh request-to-update milliseconds. Correlate these with existing `[kanban-pr-refresh]` UI elapsed logs while triggering a refresh and editing another card. Include repository-coordinator queueing and UI rendering when recording true click-to-update latency; backend timing alone does not include them. No live PRs or user data are modified by the controlled benchmark.
