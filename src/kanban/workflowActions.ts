import type { Project } from '../types';
import type { KanbanCard } from './types';

export type CardWorkflowActionKind = 'open_refinement' | 'write_plan_and_finish_refinement' | 'stop_refinement' | 'start_work' | 'return_to_refinement' |
  'ship' | 'ship_with_fe' | 'request_changes' | 'merge_local' | 'create_pr' | 'open_pr' | 'merge_pr' | 'cleanup' | 'cleanup_creation' | 'close' | 'delete';

export type CardWorkflowActionAppearance = 'regular' | 'neutral-ghost' | 'danger-ghost';

export type CardWorkflowAction = {
  kind: CardWorkflowActionKind;
  label: string;
  primary?: boolean;
  destructive?: boolean;
  appearance?: CardWorkflowActionAppearance;
  confirmation?: { title: string; detail: string };
  disabledReason?: string;
  loading?: boolean;
  error?: string;
};

export type CardWorkflowContext = {
  card: KanbanCard;
  project?: Project | null;
  projectAvailable: boolean;
  activeTab?: 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';
  operation?: { kind: CardWorkflowActionKind; error?: string } | null;
  backendPreflight?: { ok: boolean; message?: string } | null;
};

/** Pure source of truth for workflow labels and availability in every card tab. */
export function deriveCardWorkflowActions(context: CardWorkflowContext): CardWorkflowAction[] {
  if (context.card.hierarchy_finalized) return [];
  const actions = baseCardWorkflowActions(context)
    .filter((action) => action.kind !== 'open_refinement' || context.activeTab !== 'chat');
  return actions.map((action) => ({
    ...action,
    loading: context.operation?.kind === action.kind && !context.operation.error,
    error: context.operation?.kind === action.kind ? context.operation.error : undefined,
    disabledReason: action.disabledReason ?? (action.kind === 'merge_local' && context.backendPreflight && !context.backendPreflight.ok
      ? context.backendPreflight.message ?? 'Merge preflight failed'
      : undefined),
  }));
}

function baseCardWorkflowActions({ card, project, projectAvailable }: CardWorkflowContext): CardWorkflowAction[] {
  const environment = card.environment;
  const close: CardWorkflowAction = { kind: 'close', label: 'Close without delivery', destructive: true, appearance: 'neutral-ghost', confirmation: { title: 'Close without delivery?', detail: 'Moves this card to Done · Closed and stops its processes. The worktree, branch, and changes are preserved.' } };
  const actions: CardWorkflowAction[] = (() => {
    switch (card.status) {
      case 'needs_refinement': return [
        { kind: 'open_refinement', label: 'Open refinement', primary: true, disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        { kind: 'write_plan_and_finish_refinement', label: 'Write plan & finish refinement', disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        ...(!environment && card.provider === 'local' ? [{ kind: 'delete' as const, label: 'Delete card', destructive: true, appearance: 'danger-ghost' as const, confirmation: { title: 'Delete card?', detail: 'This permanently deletes this local draft.' } }] : []),
      ];
      case 'refining': return [
        { kind: 'stop_refinement', label: 'Stop refinement', destructive: true, appearance: 'neutral-ghost' },
      ];
      case 'needs_refinement_input': return [
        { kind: 'open_refinement', label: 'Open refinement', primary: true, disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        { kind: 'write_plan_and_finish_refinement', label: 'Write plan & finish refinement', disabledReason: projectAvailable ? undefined : 'Assign a project first' },
        { kind: 'stop_refinement', label: 'Stop refinement', destructive: true, appearance: 'neutral-ghost' },
      ];
      case 'ready': return card.creation_operation ? [
        { kind: 'start_work', label: 'Resume start', primary: true, disabledReason: projectAvailable ? undefined : 'Owning project is unavailable' },
        ...(card.creation_operation.cleanup_available ? [{ kind: 'cleanup_creation' as const, label: 'Clean up', destructive: true, appearance: 'regular' as const, confirmation: { title: 'Clean up setup resources?', detail: 'Removes only the clean worktree and unchanged branch proven to have been created by this start operation.' } }] : []),
      ] : [
        { kind: 'return_to_refinement', label: 'Return to refinement' },
        { kind: 'start_work', label: 'Start work', primary: true, disabledReason: projectAvailable ? undefined : 'Assign a project first' },
      ];
      case 'agent_working': return [];
      case 'needs_human': return [
        { kind: 'request_changes', label: 'Request changes' },
        { kind: 'ship', label: 'Ship It', primary: true },
        ...(project?.delivery_workflow === 'github_pull_request' && project.supports_feature_environments
          ? [{ kind: 'ship_with_fe' as const, label: 'Ship it w/FE' }]
          : []),
      ];
      case 'approved': {
        if (project?.delivery_workflow === 'github_pull_request') {
          if (!card.pull_request || card.pull_request.state === 'closed') return [
            { kind: 'request_changes', label: 'Request changes' },
            { kind: 'ship', label: 'Ship It again' },
            { kind: 'create_pr', label: 'Create PR', primary: true },
          ];
          if (card.pull_request.state === 'merged') return [];
          return [
            { kind: 'request_changes', label: 'Request changes' },
            { kind: 'open_pr', label: 'Open PR' },
            { kind: 'merge_pr', label: 'Merge PR', primary: true, disabledReason: card.pull_request.blockers.join('; ') || undefined },
          ];
        }
        return [
          { kind: 'request_changes', label: 'Request changes' },
          { kind: 'ship', label: 'Ship It again' },
          { kind: 'merge_local', label: 'Merge locally', primary: true, confirmation: { title: `Merge into ${project?.target_branch ?? 'main'}?`, detail: `Create an explicit --no-ff merge commit in the project's primary checkout. Cleanup is separate.` } },
        ];
      }
      case 'done': return environment ? [
        { kind: 'cleanup', label: 'Clean up', destructive: true, appearance: 'regular', confirmation: { title: 'Clean up environment?', detail: card.completion_outcome === 'closed' ? 'Removes only the clean registered worktree. The unmerged branch is retained.' : 'Removes the clean registered worktree and safely deletable source branch.' } },
      ] : [];
    }
  })();
  return card.status === 'done' || card.creation_operation ? actions : [...actions, close];
}
