# Workspace plumbing consolidation (#297)

## Inventory and boundaries

Inspected both entry points before extracting shared behavior:

| Area | Existing shared plumbing | Remaining duplication / decision |
| --- | --- | --- |
| Agent | `PiGuiView`, Pi session controllers | Extract `WorkAgentView` for lazy loading, visibility, and pane wiring. Adapters retain stable owner/thread IDs, working directories, labels, and card deployment output. |
| Terminal | `WorkspaceShellController`, `WorkspaceShellView`, session manager | Extract `useWorkspaceShellShortcuts`; retain separate project/card layout persistence and card-only temporary-command setup. |
| Diff | `DiffTab`, `DiffOverlay`, `useDiffReview` | Extract `WorkDiffView` including keyboard navigation and editable/control guards. Extract `useWorkDiffRefresh` for accepted selection/reselection and explicit refresh. |
| Managed services | `useManagedServices`, service controller and registry | Extract `WorkServiceTerminal`; keep card service adapter for worktree ownership and board-background hosting. |
| Notes / card description | Project autosave vs card edit/revision workflow | Intentionally separate. |
| Tabs / workflow / release | Distinct project and card navigation models | Intentionally separate. No tab nesting, renamed entry points, or release behavior/settings changes. |

Project work remains card-independent: project owner IDs and root paths, remote comparison target, project-scoped notes and direct-work persistence. Cards keep planning/work thread IDs, worktree paths and local target-branch comparison, card editing/actions/revisions and environment layout persistence.

## Lifecycle constraints

Shared views pass the same pane IDs to the existing renderers and remain mounted when inactive. Card thread changes still replace the agent renderer by ID. Service enabled state, not tab visibility, controls terminal rendering. Board-hosted service background classes remain unchanged.

No session-cache, PTY generation guard, focus-routing, service-registry, process cleanup, or shell-controller implementation was changed. Shortcut subscriptions are removed on view disposal without owning process cleanup. Project shell kill requests retain their expected-CWD guard; card cleanup and layout revision coordination remain in their existing adapters.

`ReleaseTab` stays at the project entry point with its existing enabled setting and active-view mount condition. Card #298 can evolve release UI/configuration independently of these shared agent/diff/service views.

## Regression coverage

- Existing `DiffClose.test.tsx` exercises both real entry points: mouse/keyboard Diff selection/reselection, explicit refresh, preservation of review drafts, disabled Diff/tab numbering, and review close/submit.
- `CardDiffView.test.tsx` runs the shared diff navigation, keyboard guards, refresh reconciliation and stale-patch cases for both project and card contexts, including their different comparison targets.
- `WorkViews.test.tsx` covers both owners' agent/service identity, visibility changes, remounts, UTF-8 input, restart state, no view-owned process cleanup, and card planning/work paths.
- `useWorkspaceShellShortcuts.test.tsx` covers both owners' active-view gating, command routing, unsubscribe and remount behavior.
- Existing shell controller, session manager, PTY generation and managed-service suites remain the lifecycle regression tests.
