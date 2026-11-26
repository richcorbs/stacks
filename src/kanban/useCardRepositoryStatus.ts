import type { GitInfo } from '../types';
import type { CardEnvironmentHealth, EnvironmentHealthStep, KanbanCard } from './types';

export type CardRepositoryStatus = {
  git: GitInfo | null;
  environmentHealth: CardEnvironmentHealth;
};

export function healthCheckFailure(card: Pick<KanbanCard, 'id' | 'status'>, error: unknown): CardEnvironmentHealth {
  const step: EnvironmentHealthStep = card.status === 'needs_human' ? 'approval'
    : card.status === 'approved' ? 'merge'
      : card.status === 'done' ? 'cleanup' : 'work';
  const detail = error instanceof Error ? error.message : String(error);
  return {
    card_id: card.id,
    issues: [{
      code: 'health_check_failed',
      message: `Stacks could not check this environment${detail ? `: ${detail}` : '.'}`,
      step,
    }],
  };
}

const REPAIRABLE_ON_FINALIZED = new Set([
  'parent_state_inconsistent',
  'finalized_parent_without_children',
  'stale_parent_child_count',
]);

export function shouldShowEnvironmentWarning(
  card: Pick<KanbanCard, 'hierarchy_finalized'>,
  health: CardEnvironmentHealth | null | undefined,
) {
  // A stale finalized flag is a repairable projection, not an aggregate: show the
  // banner and its one-click repair instead of hiding the card's only way forward.
  return Boolean(health?.issues.length)
    && (!card.hierarchy_finalized || health?.issues.some((issue) => REPAIRABLE_ON_FINALIZED.has(issue.code)));
}

export function environmentHealthTooltip(health: CardEnvironmentHealth | null | undefined) {
  if (!health?.issues.length) return '';
  return health.issues.map((issue) => `${issue.message} Affects ${issue.step}.`).join(' ');
}

export const unavailableGitStatus = (): GitInfo => ({ branch: '', status: 'error', message: 'Git status could not be read. Check the worktree and retry refresh.' });

export function hasGitChanges(git: GitInfo | null | undefined) {
  return Boolean(git?.status === 'ok' && (git.created > 0 || git.changed > 0 || git.deleted > 0));
}
