# Manual Done-card retirement

Cmd+P → **Clean up all Done cards completed more than 7 days ago**.

This is an explicit global discard operation, not a timer or startup task. It
considers all persisted local and Superthread-backed copies across all projects,
including out-of-scope cards and all Done outcomes. Only confirmed IDs and their
continuous Done-entry timestamps are considered; newly eligible cards wait until
the next invocation. The shared confirmation boundary retains its Cancel-first
focus, two-second countdown, and submission guard. There are no per-card prompts.

The confirmation authorizes stopping card Pi processes, terminals (including
managed services), and setup work, forcibly removing **owned, registered local
Git worktrees even when dirty**, deleting **owned local branches even when
unmerged**, then deleting local records, history, sessions and card-owned files.
Uncommitted content is not preserved by Git history; deleting an unmerged branch
can also make its commits unreachable and eventually unrecoverable. Runtime
shutdown stops Pi without deleting its conversations before Git cleanup succeeds.

## Remote policy

- **Remote Git branches are not deleted.** Retirement performs no network Git
  effects and does not close, merge, or delete pull requests. Remote Git history
  can remain, independently of whether a local branch was merged.
- **Remote Superthread cards are not modified or deleted.** They remain the
  provider historical record. Retirement atomically adds a
  `retired_provider_cards(binding_id, external_id)` tombstone with local deletion.
  Subsequent imports ignore that remote ID for the same binding, even after a
  remote column change. A different account/binding is independent. Tombstones
  are permanent; there is no automatic resurrection or expiry. Missing binding
  identity is an actionable failure, not permission to delete without suppression.
- Pending provider operations cannot execute for the authorized Done period while
  retirement is pending. Existing failed/queued journals are not exclusion rules.

## Retention clock

Migration 78 adds `kanban_cards.done_entered_at` (Unix seconds). SQLite triggers
maintain it on insertion and actual status transitions. Edits, provider refreshes,
and outcome changes while continuously Done leave it unchanged. Leaving Done
clears it; re-entry starts a fresh period. Eligibility is strictly
`done_entered_at < now - 604800`, not `<=`. `updated_at` is never an age source.
Conservative history backfill and project-store rebuild behavior are unchanged.

The sweep is one caller of the single retirement path (card #341): each candidate
runs `RemoveResources` (runtime, worktrees, branches) and then `DeleteRecord`
(record, history, files). Both intents are journaled as
`retire_remove_resources` / `retire_delete_record` in the unified operations
journal. See `docs/kanban-retirement.md`.

## Durable execution and retry

Migration 80 adds the retirement journal and binding-scoped provider tombstones.
Each card is independent; failures do not roll back successful cards. Qualifying
hierarchy members retire regardless of parents/children. Surviving children are
detached (`parent_id=NULL`) in the deletion transaction, never deleted merely due
to their relationship. Remote hierarchy relationships are untouched.

1. Commit authorization with card/provider/project identity and the exact Done
   timestamp **before** any destructive process or filesystem effects.
2. Cancel supervised setup and wait for its worker to finish. A timeout, orphan
   setup still alive, or unrecorded Git inventory drift is a reported failure.
   Unknown PID ownership is not a reason to kill an arbitrary process.
3. Coordinate using durable repository evidence, not a source path that may
   already be removed. Capture resource paths, repository identity, branches,
   current exact tips, and resource-ledger evidence once, before Git effects.
   Environment-creation and existing cleanup journals participate in ownership
   recovery rather than automatically blocking retirement.
4. Execute durably journaled phases: runtime shutdown → worktree removal → local
   branch compare-and-delete → storage staging/local record deletion. Each phase
   holds the board mutation lock from fresh Done/identity/ownership validation
   through its effects. Resource startup is serialized and prohibited for that
   pending Done period. A reactivated card can start resources normally; stale
   retirement cannot continue deleting it.
5. A new explicit confirmation for a later qualifying Done period starts fresh
   capture while preserving old ownership evidence for resources already removed.
   Ordinary retries retain the original captured tips and ledger evidence.
6. Rename card files to `cards/.done-cleanup-<storage-key>` in the same transaction
   as database cascades, tombstone insertion, and a `local_card_purge_jobs` entry.
   Then purge staged files. Interrupted staging with a retained record is restored
   or discovered on retry. Purge failures retain the durable job, report that the
   record is gone but files remain, and are retried by this action even with zero
   new candidates. Only a completed purge counts as fully retired.

A crash between a Git effect and phase commit leaves the previous phase and
ownership evidence intact. Retrying safely accepts already absent resources
only with durable proof. No ownership evidence is discarded on failure.

## Ownership is not overridden by discard authorization

Checks reject primary checkouts/target branches, wrong repositories, changed
branch tips, detached or unregistered checkouts, symlinked source/storage
ancestors, nested Git checkouts, overlapping/shared card resource claims, branches
checked out elsewhere, changed project targets, changed resource ledgers, and
lossy/shared storage keys. There is no fallback `rm -rf` for an unregistered
worktree. Local refs use expected-tip compare-and-delete. Genuine Git, permission,
shutdown, ownership, and storage failures retain evidence and appear in results
with retry instructions; they are not called successful retirement or quietly
skipped. Only cards outside the confirmed continuous Done period are excluded.

The development-data seeder clears production retirement/purge jobs (which refer
to production resources), while preserving historical provider tombstones.

## Validation

Tests cover strict age boundaries and timestamp transitions/backfill, both
providers/projects, hierarchy detachment and cascades, stale previews/reactivation,
real dirty/unmerged Git resources, ownership ambiguity and changed tips/ledgers,
shutdown failure, supervised setup cancellation/waiting, genuine Git failure and
retry, crashes after worktree/ref removal before phase commits, staged-file and
partial-purge recovery, symlink/key safety, board removal events, binding-scoped
Superthread suppression, progress/results, and shared confirmation guards.

Smoke testing should use disposable cards in an isolated profile. Never age or
retire real user cards merely to validate this action.
