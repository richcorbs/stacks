import type { CardCleanupOperation } from '../kanban/types';

export const CLEANUP_PHASE_LABELS: Record<CardCleanupOperation['phase'], string> = {
  runtime_sessions: 'Stopping card sessions',
  validate_repository: 'Validating repository safety',
  remove_worktree: 'Removing source worktree',
  delete_local_branch: 'Deleting local source branch',
  delete_remote_branch: 'Deleting remote source branch',
  remove_metadata: 'Removing environment metadata',
  record_completion: 'Recording completion',
};

export function cleanupPhaseLabel(phase: CardCleanupOperation['phase']): string {
  return CLEANUP_PHASE_LABELS[phase];
}

export function CardCleanupStatus({ operation }: { operation: CardCleanupOperation }) {
  if (operation.status === 'completed') return null;
  return (
    <aside className="cardCleanupStatus" aria-labelledby="card-cleanup-status-title">
      <div><strong id="card-cleanup-status-title">Cleanup {operation.status}</strong><span>{cleanupPhaseLabel(operation.phase)}</span></div>
      {operation.error_detail && <p role="alert">{operation.error_detail}</p>}
      <small>Fix the issue, then use Retry cleanup. Cleanup will resume from this phase.</small>
    </aside>
  );
}
