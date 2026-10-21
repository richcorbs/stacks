# Manual Done-card retention

Cmd+P → **Clean up all Done cards completed more than 7 days ago**.

- Global: queries persisted cards in every project, including out-of-scope cards,
  local cards, and Superthread-backed copies. All Done outcomes use `status=done`.
- Preview is read-only. Confirmation states the candidate count, permanent local
  deletion, and all-project scope. Cancelling does not mutate anything.
- Execution only considers the confirmed IDs and Done-entry timestamps, then
  revalidates current status, age, hierarchy, runtime inventory, and operations.
  Cards that became eligible after preview wait for the next invocation.
- No timer, startup cleanup, provider mutations, remote deletion, Git commands,
  branch removal, or worktree teardown are part of this action.

## Retention clock

Schema migration 78 adds `kanban_cards.done_entered_at` (Unix seconds). SQLite
triggers maintain it on insert and actual status changes, including provider
scope transitions and hierarchy reconciliation. Edits, syncs and outcome changes
while continuously Done leave it unchanged. Leaving Done clears it; re-entry
starts a fresh period. Eligibility is strictly `< now - 604800`, not `<=`.

Backfill uses the latest successful non-Done → Done history event only if there
is no later successful exit in the retained history. Missing or contradictory
history starts retention at migration time. `updated_at` is never an age source.
The project-store identity-table rebuild preserves the timestamp and reinstalls
its triggers.

## Safety and partial failures

Linked local hierarchies are retention units: a retained/unsafe member blocks its
connected group. Fully eligible groups are deleted leaf-first in a group
savepoint. A failure retains the entire group's database records; unrelated
groups may still succeed. Existing board revision/removal events update boards
and invalidate deleted selections/details without restarting. Frontend session
caches are retired without workflow reconciliation or backend session mutations.

Cards with environments, unresolved setup/merge/delivery/provider/cleanup work,
legacy workspace references, open PRs, or registered/starting runtimes are skipped.
Resource startup and final deletion share a lock. Shared lossy directory keys,
symlinked storage ancestors and nested Git checkouts are not deleted.

Card-owned files are first renamed to a deterministic sibling directory:
`cards/.done-cleanup-<storage-key>`. Card deletion/cascades and a durable
`local_card_purge_jobs` entry commit together, then staged files are removed.
Failed purges retain the job and report the path/error; invoking this same action
retries them, even with zero newly eligible cards. Interrupted staging with a
retained card is restored or discovered on retry. Do not manually discard a
staging directory without checking the corresponding card and pending purge job.

Purge jobs are temporary filesystem recovery work, **not tombstones or import
suppression**. They are removed after successful file removal and are never
consulted by Superthread import. Ordinary re-import rules remain unchanged.
The development-data seeder discards these production-owned filesystem jobs.

## Validation

Automated coverage includes strict age boundaries, both providers/projects and
Done outcomes, timestamp transitions/backfill, retained hierarchy/resource
blockers, group rollback, database cascades, staging/crash retries, partial file
failure recovery, symlink/key safety, board removal revisions, Superthread
re-import, palette availability, confirmation/cancellation/empty/results, and
frontend retirement without workflow mutations.

For manual smoke testing, use an isolated profile with disposable cards: open
Cmd+P both with and without a selected project; cancel once; confirm cleanup;
check counts and any open deleted detail; verify remote cards are unchanged and
a backwards-moved Superthread card can be imported normally. Do not age or delete
real user cards just to run this smoke test.
