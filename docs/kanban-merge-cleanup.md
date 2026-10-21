# MERGE & CLEANUP handoff (#271)

## Diagnosis

Read-only inspection of the installed app's persisted workflow database found two
Done/Merged cards with `delivery_operation_stage=deleting_remote_branch` and errors
of this form (repository URLs and branch names omitted):

```text
PR merged, but remote branch deletion needs retry:
remote rejected ... cannot lock ref ... unable to resolve reference
```

Examples were `superthread:2402` (workflow revision 10) and `superthread:2407`
(workflow revision 26). This is direct evidence of a post-merge delivery failure,
not evidence of missing cleanup context or a publication race. It does not prove
that every historical report had the same cause.

`github_delivery.rs` persists the merge and PR state before attempting remote
branch deletion, then returns the merged card with `delivery_error` if deletion
fails. Previously `useBoardPrMerge` treated that warning as a reason not to call
cleanup preflight. Opening details and invoking CLEANUP avoided that gate.
Cleanup already checks remote absence and exact-tip leases; those backend checks
must remain authoritative. No backend deletion or authorization changes are
needed for this handoff fix.

## Handoff and recovery

- Recognize persisted merge completion independently of delivery errors.
- Reload persisted details before preparing cleanup, preserving the original
  card/project/PR/environment identity.
- Fetch existing cleanup preflight, then reload details again because preflight
  itself refreshes PR evidence. Require matching evidence revisions and identity.
- Close the merge dialog before presenting the existing cleanup confirmation.
- Revalidate identity/revisions again when confirmation is submitted; the backend
  still performs its own authoritative authorization and repository checks.
- Preparation blockers and execution failures offer **Retry cleanup** in the
  board dialog. This reloads state and evidence, never calls merge, and requires
  confirmation again. Explicitly available cleanup overrides still use the
  existing confirmation/authorization flow.
- Ref guards prevent concurrent merge, preparation, recovery, and cleanup
  submissions. Cancelling confirmation only closes the dialog and restores focus.

Regression tests cover the captured remote-deletion warning, evidence refresh
publication, cancellation, merge-only, stale/wrong evidence, environment
replacement, safety blockers, duplicate submissions, and execution recovery.
Standalone detail cleanup and backend cleanup are unchanged.

## Manual validation still required

Use an explicitly approved eligible test PR; do not merge arbitrary live work:

1. From board/list, MERGE & CLEANUP without opening details. Verify the second
   confirmation identifies the exact card. Cancel and verify local resources stay.
2. Exercise cleanup-only recovery after a preparation/execution failure; verify
   GitHub merge is not invoked again and safety blockers remain enforced.
3. Confirm cleanup while another workspace is focused; verify only the captured
   registered worktree and its sessions are cleaned.
4. Verify MERGE alone retains resources and detail CLEANUP still works.

No real PR was merged or local worktree removed during automated validation.
