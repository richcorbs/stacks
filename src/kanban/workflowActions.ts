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
// Priority is independent of availability: a blocked forward action must not
// turn an enabled destructive alternative into the default.
const priority: CardWorkflowActionKind[] = [
  'finish_refinement', 'open_refinement', 'stop_refinement', 'start_work',
  'return_to_refinement', 'ship', 'merge_local', 'create_pr', 'create_pr_with_fe',
  'merge_pr', 'push', 'retry_push', 'deploy', 'retry_deploy', 'confirm_deployed',
  'run_deployment_again', 'merge_target', 'retry_runtime_cleanup', 'cleanup',
  'cleanup_creation', 'open_pr', 'request_changes', 'cancel_deployment', 'close', 'delete',
];

function primaryKind(context: CardWorkflowContext, displayed: CardWorkflowActionKind[]): CardWorkflowActionKind | undefined {
  const preferred: CardWorkflowActionKind[] = context.card.status === 'needs_refinement'
    ? ['open_refinement', 'start_work']
    : context.card.status === 'refining' ? ['stop_refinement']
    : context.card.status === 'needs_refinement_input' ? ['finish_refinement', 'stop_refinement']
    : context.card.status === 'ready' ? ['start_work', 'return_to_refinement']
    : context.card.status === 'approved' && context.project?.delivery_workflow === 'local_merge'
      ? ['merge_local', 'ship']
      : context.card.status === 'approved' && context.project?.delivery_workflow === 'github_pull_request'
        ? ['merge_pr', 'create_pr', 'ship']
        : context.card.status === 'approved' && context.project?.delivery_workflow === 'scripted_delivery'
          ? ['push', 'retry_push', 'deploy', 'retry_deploy', 'confirm_deployed', 'run_deployment_again', 'merge_local']
          : [];
  return [...preferred, ...priority, ...displayed].find((kind) => displayed.includes(kind));
}

/** Adds labels, confirmation copy, appearance, and transient operation state to backend capabilities. */
export function deriveCardWorkflowActions(context: CardWorkflowContext): CardWorkflowAction[] {
  const displayed = context.card.capabilities
    .filter(({ action }) => context.card.status !== 'needs_refinement'
      ? action !== 'open_refinement' || context.activeTab !== 'chat'
      : action !== 'finish_refinement' && action !== 'delete')
  const selected = primaryKind(context, displayed.map(({ action }) => action));
  return displayed.map(({ action, available, disabled_reason }) => {
    const presentation = presentationFor(action, context);
    const operation = context.operation?.kind === action;
    return {
      kind: action,
      label: action === 'open_refinement' && context.card.status === 'needs_refinement' ? 'Refine'
        : action === 'ship' && context.card.status === 'approved' ? 'Commit updates'
        : action === 'start_work' && context.card.creation_operation ? 'Resume start'
        : action === 'cleanup' && context.card.cleanup_operation && context.card.cleanup_operation.status !== 'completed' ? 'Retry cleanup'
        : labels[action],
      primary: action === selected || undefined,
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
