# GPUI card workflow footer — scope (card #323)

## Goal

Add the card-detail workflow action bar to the native GPUI detail view with the
same action set, labels, primary/ghost treatment, disabled reasons,
confirmations and keyboard behavior as `KanbanCardDetail` in the shipped
Tauri/React app.

This is not just a visual footer: the shipped footer is the entry point to the
workflow mutation engine. Scoping it separately prevents GPUI from duplicating
or bypassing ownership of status transitions, environments, Git, GitHub, Pi and
process cleanup.

## Current status

- Shared engine extracted to `crates/stacks-workflow`; Tauri re-exports it.
- Native detail now loads `WorkflowContext` and shared action presentation from
  `stacks-cards`.
- The footer shell is rendered with GPUI Kit buttons on Description, Agent and
  Diff.
- Phase 2a is wired for local cards: `Return to refinement`, `Stop refinement`
  and `Request changes`. These perform transactional status/revision/event
  updates and refresh the open detail.
- Phase 2b adds `Delete card` for local drafts behind the native confirmation
  dialog: Cancel focused first, two-second countdown, then the enabled
  destructive action.
- `Close without delivery` is now wired for local cards: confirmation,
  Done/Closed transition, GPUI service/Pi teardown, Pi-session removal, and the
  runtime-cleanup status/event contract.
- `Open PR` is enabled when the card has an open pull request; it opens the PR
  URL directly.
- `Open refinement` now transitions to Refining, opens the planning Agent, and
  applies Pi lifecycle events (`agent_started`, `agent_settled`,
  `process_exited`) back into the card workflow.
- `Start work` is enabled for local projects using the built-in Git setup:
  clean target checkout validation, sibling worktree/branch creation,
  environment/pane/layout rows, Start-work transition and work-agent launch.
  Custom start-work commands remain owned by the Tauri environment engine.
- `Approve & commit` is enabled for local work cards: it asks the work agent to
  commit, waits for the agent to settle, requires a clean worktree, then applies
  the Approved transition.
- `Merge locally` is enabled for approved local cards with a clean target
  checkout and worktree. It creates an explicit `--no-ff` merge commit and
  moves the card to Done/Merged.
- `Clean up` is enabled for Done/Merged local cards. It verifies the worktree is
  clean and the branch is merged, removes the registered worktree and local
  branch, deletes the environment metadata, and records the cleanup event.
- `Merge in target & resolve` merges the project target branch into a clean
  local worktree with `--no-ff`; conflicts are aborted and reported.
- `Merge PR` uses `gh pr merge --merge` after capability blockers pass, updates
  the pull-request row, and moves the card to Done/Merged.
- `Create PR` and `Create PR with FE` push the card branch and run
  `gh pr create`, then store the pull-request state for the existing
  capability/blocker projection. FE PRs use the `[FE]` title prefix and mark the
  card feature environment.
- Scripted delivery is wired for Push, Deploy, retry, run-again and confirm:
  Merge locally records durable merge evidence, push verifies the upstream tip,
  deploy runs the project deployment command, and success completes the card.
  Deployment runs as a supervised process group; Cancel terminates it and
  records the cancelled stage for retry.

## Existing behavior to match

Source of truth:

- `src/kanban/workflowActions.ts` — capability → action presentation, priority,
  labels, confirmations and appearances.
- `src/kanban/cardWorkflowExecutor.ts` — confirmation, operation lock,
  execution sequencing and refresh rules.
- `src/components/CardWorkflowControls.tsx` — footer layout and button styling.
- `src/components/kanban/KanbanCardDetail.tsx` — footer visibility, `Cmd+Enter`
  primary action and confirmation boundary.
- `src-tauri/src/kanban/workflow.rs` — transition and capability rules.
- `src-tauri/src/kanban/*` — action side effects.

Behavior details:

- Footer is visible only on `Description`, `Agent`, and `Diff` tabs
  (`overview/chat/diff` in React). It is hidden on Terminal, Server and Console.
- Regular actions are left-aligned; neutral/danger ghost actions are right
  aligned. Disabled actions expose the backend reason as a tooltip.
- The primary action follows status/project/delivery rules. `Cmd+Enter` runs it,
  but non-confirmation shortcuts first open the shortcut confirmation dialog.
- Destructive/ambiguous actions use the shared confirmation boundary: Cancel
  focused initially, primary action delayed two seconds, visible countdown.
- One workflow operation runs at a time. Actions are disabled while an operation
  is active, except `cancel_deployment`.
- Actions that change repositories refresh the card snapshot and Git/diff state.
- Start/open/return/request-changes navigate to the Agent tab when appropriate.
- Errors and backend disabled reasons are shown in the card detail error banner,
  not silently discarded.

## Current native gap

`apps/stacks-gpui` currently has a read-only card projection:

- `crates/stacks-cards` loads `workflow.sqlite3` read-only. `CardSummary` has no
  `capabilities`, creation/cleanup operation flags, or retry flags.
- There is no native workflow action service. Mutation, worktree creation, Pi
  lifecycle changes, Git/GitHub delivery and cleanup still live under
  `src-tauri/src/kanban/`.
- The GPUI detail has no footer. Actions cannot be made "real" by rendering
  buttons over a read model.

## Architecture options

### A. Extract shared workflow engine (recommended)

Create a Tauri-free crate, e.g. `crates/stacks-workflow`, containing:

- `WorkflowAction`, `CardStatus`, `DeliveryWorkflow`, transition/capability logic
  and the `WorkflowContext` projection.
- Capability DTOs and action presentation metadata shared by Tauri and GPUI.
- A host trait for side effects:
  - update card/status/event rows transactionally
  - create/remove worktrees and branches
  - start/stop Pi sessions and processes
  - Git/GitHub/scripted-delivery operations
  - publish operation progress/cancellation

Tauri becomes one host implementation; GPUI becomes another. This avoids two
workflow implementations and preserves the existing contract tests.

Cost: high. It touches the most sensitive backend code and needs a staged
migration with contract/golden tests before UI work.

### B. Extend `stacks-cards` with a narrow native workflow service

Keep Tauri as-is initially. Add capability projection plus a writable
`WorkflowService` for DB-only and local-safe actions first. Defer actions that
need environment creation, Pi lifecycle, Git/GitHub or cleanup.

This gets a real footer quickly for:

- `return_to_refinement`
- `close`
- `delete`
- possibly `finish_refinement` / `stop_refinement` at the planning-session level
- cleanup-creation only if worktree ownership can be proven natively

It will fork workflow logic unless the transition/capability module is shared
with Tauri, and it cannot deliver full parity.

Cost: medium. Good for an incremental native surface, not full parity.

### C. Bridge GPUI actions to the running Tauri app

Send workflow commands over local IPC to the shipped app.

Not recommended: it makes the native shell dependent on the legacy app being
open, splits error/operation state across processes, and defeats the native
migration goal. Only viable as a temporary demo.

## Recommended scope

Choose A, but stage it so the footer lands before the entire engine moves.

### Phase 0 — contract and fixtures (S)

- Add golden fixtures covering every status, delivery workflow, environment
  state, PR state, creation/cleanup/retry operation, parent/child and finalized
  hierarchy.
- Capture the React action list (kind, label, primary, appearance, disabled
  reason, confirmation) for each fixture.
- Ensure the existing `workflowContract.generated.ts` check enforces any shared
  enum changes.

Exit: GPUI can compare its capability output against React fixtures without UI.

### Phase 1 — shared capabilities + read-only footer (M)

- Extract or mirror `WorkflowContext` + `capabilities()` in a shared crate.
- Extend the native detail read model with the missing context inputs:
  creation operation, cleanup operation, runtime cleanup retryability,
  work-agent launch retryability, provider compatibility, local-parent/child
  flags.
- Add `capabilities` to the native card detail payload.
- Render the footer with GPUI Kit components:
  - `Button` variants for primary, secondary, neutral ghost and danger ghost.
  - `Spinner`/loading label for the running action.
  - project accent on the primary button.
  - regular group left; ghost group right.
- Hide the footer on Terminal, Server and Console.
- Tooltip/disabled reason and action error banner.

Exit: action bar looks and derives exactly like React; actions may be visibly
disabled with "Native workflow action not wired yet" until Phase 2.

### Phase 2 — safe local actions (M/L)

- Add a writable native workflow service with transaction + revision checks.
- Implement `return_to_refinement`, `close`, `delete` first.
- Reuse the existing event/revision conventions and stop GPUI-owned card
  services/Pi processes before close/delete.
- Add operation lock, confirmation boundary, `Cmd+Enter`, error handling and
  post-action refresh.
- Golden tests for status transitions, event rows, revisions and conflict
  detection.

Exit: footer is genuinely useful for backlog/housekeeping actions.

### Phase 3 — refinement and start work (L)

- Port/extract planning-session finish/stop rules and status projection.
- Port environment creation/recovery and work-agent launch.
- Keep Pi lifecycle authority in one place; do not duplicate session
  reconciliation in GPUI.
- Implement `start_work`, `open_refinement`, `finish_refinement`,
  `stop_refinement`, `request_changes`.
- Navigate to Agent on the actions that do so in React.

Exit: Ready → Agent working lifecycle works natively.

### Phase 4 — delivery engine (L/XL)

- `ship` / approve-and-commit.
- local merge, target merge, PR creation/merge, feature-environment PRs.
- scripted delivery push/deploy/retry/confirm/cancel.
- cleanup and runtime cleanup.
- operation progress streaming into the footer/output surface.

Exit: full action-set parity, including destructive confirmations and failure
reasons.

### Phase 5 — polish and parity hardening (S/M)

- Exact 2s confirmation delay/focus behavior via shared `ConfirmDialog`.
- `Cmd+Enter` runs the primary footer action; actions with confirmation copy
  route through the native confirmation dialog.
- Disabled reasons/tooltips, busy/loading states, action error banner.
- Snapshot refresh rules after repository-changing actions.
- Visual pass against the shipped footer, including project accent and ghost
  action placement.
- Tests: capability golden tests, action executor tests, UI interaction tests,
  no regressions in read-only LIST.

## Key decisions needed

1. Do we extract the workflow engine into a shared crate now (A), or ship a
   narrow native subset first (B)?
2. Which actions are in the first usable milestone: housekeeping only, or must
   Start work be included?
3. Who owns process/Pi lifecycle when both apps can mutate the same card? Native
   should become the sole owner for GPUI actions; define a handoff rule.
4. Should GPUI refuse actions while the Tauri app has an active workflow
   operation, or rely on revision/conflict checks?
5. Do we need an operation/progress stream for scripted delivery in the first
   pass, or defer it to Phase 4?

## Non-goals for the first footer pass

- Reimplementing Git/GitHub/worktree logic inside the view layer.
- Adding SQL or workflow rules directly to `apps/stacks-gpui`.
- Duplicating React labels/confirmations by hand without fixture tests.
- Enabling actions that mutate state before the native service has conflict
  detection and event/revision writes.
