import type { KanbanCard } from './types';

export type CardWorkflowActionKind = 'open_refinement' | 'write_plan_and_finish_refinement' | 'start_work' | 'return_to_refinement' |
  'open_agent' | 'approve_and_commit' | 'request_changes' | 'merge' | 'reopen' | 'cleanup' | 'delete' | 'set_merge_target';

export type CardWorkflowAction = {
  kind: CardWorkflowActionKind;
  label: string;
  primary?: boolean;
  destructive?: boolean;
  confirmation?: { title: string; detail: string };
  disabledReason?: string;
  loading?: boolean;
  error?: string;
};

export type CardWorkflowContext = {
  card: KanbanCard;
  projectAvailable: boolean;
  activeTab?: 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';
  runtimeActive?: boolean;
  operation?: { kind: CardWorkflowActionKind; error?: string } | null;
  backendPreflight?: { ok: boolean; message?: string } | null;
};

/** Pure source of truth for workflow labels and availability in every card tab. */
export function deriveCardWorkflowActions(context: CardWorkflowContext): CardWorkflowAction[] {
  const actions = baseCardWorkflowActions(context)
    .filter((action) => action.kind !== 'open_refinement' || context.activeTab !== 'chat');
  return actions.map((action) => ({
    ...action,
    loading: context.operation?.kind === action.kind && !context.operation.error,
    error: context.operation?.kind === action.kind ? context.operation.error : undefined,
    disabledReason: action.disabledReason ?? (action.kind === 'merge' && context.backendPreflight && !context.backendPreflight.ok
      ? context.backendPreflight.message ?? 'Merge preflight failed'
      : undefined),
  }));
}

function baseCardWorkflowActions({ card, projectAvailable, runtimeActive = false }: CardWorkflowContext): CardWorkflowAction[] {
  const environment = card.environment;
  switch (card.status) {
    case 'needs_refinement':
      return [
        { kind: 'open_refinement', label: 'Open refinement', primary: true, disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        { kind: 'write_plan_and_finish_refinement', label: 'Write plan & finish refinement', disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        ...(!environment && card.provider === 'local' ? [{ kind: 'delete' as const, label: 'Delete card', destructive: true, confirmation: { title: 'Delete card?', detail: 'This permanently deletes this local draft.' } }] : []),
      ];
    case 'ready': return [
      { kind: 'return_to_refinement', label: 'Return to refinement' },
      { kind: 'start_work', label: 'Start work', primary: true, disabledReason: projectAvailable ? undefined : 'Assign a project first' },
    ];
    case 'agent_working': return [{ kind: 'open_agent', label: runtimeActive ? 'Open Agent' : 'Open Agent', primary: true }];
    case 'needs_human': return [
      { kind: 'request_changes', label: 'Request changes' },
      { kind: 'approve_and_commit', label: 'Approve and commit', primary: true },
    ];
    case 'approved': return environment?.target_branch ? [
      { kind: 'request_changes', label: 'Request changes' },
      { kind: 'merge', label: `Merge into ${environment.target_branch}`, primary: true, confirmation: { title: `Merge into ${environment.target_branch}?`, detail: `Merge ${environment.branch} into ${environment.target_branch} with an explicit merge commit. Cleanup is separate.` } },
    ] : [
      { kind: 'request_changes', label: 'Request changes' },
      { kind: 'set_merge_target', label: 'Set merge target…', primary: true },
    ];
    case 'merged': return environment ? [
      { kind: 'reopen', label: 'Reopen to Ready to merge' },
      { kind: 'cleanup', label: 'Clean up', destructive: true, confirmation: { title: 'Clean up environment?', detail: 'Removes only card-owned processes, source worktree, and safely deletable source branch. The card remains Merged.' } },
    ] : [{ kind: 'reopen', label: 'Reopen to Ready for agent', primary: true }];
  }
}
