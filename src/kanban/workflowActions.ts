import type { Project } from '../types';
import type { KanbanCard, KanbanWorkflowAction } from './types';

export type CardWorkflowActionKind = KanbanWorkflowAction;
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
  activeTab?: 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';
  operation?: { kind: CardWorkflowActionKind; error?: string } | null;
  backendPreflight?: { ok: boolean; message?: string } | null;
};

const labels: Record<CardWorkflowActionKind, string> = {
  open_refinement: 'Open refinement', finish_refinement: 'Write plan & finish refinement',
  stop_refinement: 'Stop refinement', start_work: 'Start work', return_to_refinement: 'Return to refinement',
  request_changes: 'Request changes', ship: 'Ship It', ship_with_fe: 'Ship it w/FE',
  merge_local: 'Merge locally', create_pr: 'Create PR', open_pr: 'Open PR', merge_pr: 'Merge PR',
  merge_target: 'Merge in target & resolve', cleanup: 'Clean up', cleanup_creation: 'Clean up',
  retry_runtime_cleanup: 'Retry process cleanup', close: 'Close without delivery', delete: 'Delete card',
};
const primary = new Set<CardWorkflowActionKind>(['open_refinement', 'start_work', 'ship', 'merge_local', 'create_pr', 'merge_pr']);

/** Adds labels, confirmation copy, appearance, and transient operation state to backend capabilities. */
export function deriveCardWorkflowActions(context: CardWorkflowContext): CardWorkflowAction[] {
  return context.card.capabilities
    .filter(({ action }) => action !== 'open_refinement' || context.activeTab !== 'chat')
    .map(({ action, available, disabled_reason }) => {
      const presentation = presentationFor(action, context);
      const operation = context.operation?.kind === action;
      return {
        kind: action,
        label: action === 'ship' && context.card.status === 'approved' ? 'Ship It again'
          : action === 'start_work' && context.card.creation_operation ? 'Resume start'
          : action === 'cleanup' && context.card.cleanup_operation && context.card.cleanup_operation.status !== 'completed' ? 'Retry cleanup'
          : labels[action],
        primary: primary.has(action) || undefined,
        ...presentation,
        loading: operation && !context.operation?.error,
        error: operation ? context.operation?.error : undefined,
        disabledReason: disabled_reason ?? (!available ? 'Action unavailable' : undefined) ??
          (action === 'merge_local' && context.backendPreflight && !context.backendPreflight.ok
            ? context.backendPreflight.message ?? 'Merge preflight failed' : undefined),
      };
    });
}

function presentationFor(action: CardWorkflowActionKind, { card, project }: CardWorkflowContext): Partial<CardWorkflowAction> {
  switch (action) {
    case 'close': return { destructive: true, appearance: 'neutral-ghost', confirmation: { title: 'Close without delivery?', detail: 'Moves this card to Done · Closed and stops its processes. The worktree, branch, and changes are preserved.' } };
    case 'delete': return { destructive: true, appearance: 'danger-ghost', confirmation: { title: 'Delete card?', detail: 'This permanently deletes this local draft.' } };
    case 'stop_refinement': return { destructive: true, appearance: 'neutral-ghost' };
    case 'merge_local': return { confirmation: { title: `Merge into ${project?.target_branch ?? 'main'}?`, detail: `Create an explicit --no-ff merge commit in the project's primary checkout. Cleanup is separate.` } };
    case 'cleanup_creation': return { destructive: true, appearance: 'regular', confirmation: { title: 'Clean up setup resources?', detail: 'Removes only the clean worktree and unchanged branch proven to have been created by this start operation.' } };
    case 'cleanup': return card.cleanup_operation && card.cleanup_operation.status !== 'completed'
      ? { destructive: true, appearance: 'regular' }
      : { destructive: true, appearance: 'regular', confirmation: { title: 'Clean up environment?', detail: card.completion_outcome === 'closed' ? 'Removes only the clean registered worktree. The unmerged branch is retained.' : 'Removes the clean registered worktree and safely deletable source branch.' } };
    default: return {};
  }
}
