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
  request_changes: 'Request changes', ship: 'Approve & commit',
  merge_local: 'Merge locally', push: 'Push', deploy: 'Deploy', retry_push: 'Retry push', retry_deploy: 'Retry deploy',
  confirm_deployed: 'Confirm deployed', run_deployment_again: 'Run deployment again', cancel_deployment: 'Cancel deployment', create_pr: 'Create PR', create_pr_with_fe: 'Create PR with FE', open_pr: 'Open PR', merge_pr: 'Merge PR',
  merge_target: 'Merge in target & resolve', cleanup: 'Clean up', cleanup_creation: 'Clean up',
  retry_runtime_cleanup: 'Retry process cleanup', close: 'Close without delivery', delete: 'Delete card',
};
const primary = new Set<CardWorkflowActionKind>(['open_refinement', 'start_work', 'ship', 'merge_local', 'deploy', 'retry_deploy', 'create_pr', 'merge_pr']);

/** Adds labels, confirmation copy, appearance, and transient operation state to backend capabilities. */
export function deriveCardWorkflowActions(context: CardWorkflowContext): CardWorkflowAction[] {
  return context.card.capabilities
    .filter(({ action }) => action !== 'open_refinement' || context.activeTab !== 'chat')
    .map(({ action, available, disabled_reason }) => {
      const presentation = presentationFor(action, context);
      const operation = context.operation?.kind === action;
      return {
        kind: action,
        label: action === 'ship' && context.card.status === 'approved' ? 'Commit updates'
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
    case 'merge_local': return { confirmation: { title: `Merge into ${project?.target_branch ?? 'main'}?`, detail: project?.delivery_workflow === 'local_merge'
      ? `Create an explicit --no-ff merge commit in the project's primary checkout, then push the configured upstream when present. Cleanup is separate.`
      : `Create an explicit --no-ff merge commit in the project's primary checkout. Push and cleanup are separate.` } };
    case 'deploy':
    case 'retry_deploy': return { confirmation: { title: 'Deploy this card?', detail: 'Stacks will safely push the current target branch if necessary, then run the project deployment command from the primary checkout.' } };
    case 'run_deployment_again': return { confirmation: { title: 'Run deployment again?', detail: 'The earlier attempt may have succeeded. Running a non-idempotent deployment command again can have side effects.' } };
    case 'confirm_deployed': return { confirmation: { title: 'Confirm deployed?', detail: 'Record that the uncertain deployment succeeded and complete this card without running the command again.' } };
    case 'cancel_deployment': return { destructive: true, appearance: 'neutral-ghost' };
    case 'cleanup_creation': return { destructive: true, appearance: 'regular', confirmation: { title: 'Clean up setup resources?', detail: 'Removes only the clean worktree and unchanged branch proven to have been created by this start operation.' } };
    // Cleanup owns a richer non-destructive preflight dialog; never substitute
    // the generic yes/no workflow confirmation.
    case 'cleanup': return { destructive: true, appearance: 'regular' };
    default: return {};
  }
}
