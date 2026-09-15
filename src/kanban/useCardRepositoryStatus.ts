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

export function environmentHealthTooltip(health: CardEnvironmentHealth | null | undefined) {
  if (!health?.issues.length) return '';
  return health.issues.map((issue) => `${issue.message} Affects ${issue.step}.`).join(' ');
}

export function hasGitChanges(git: GitInfo | null | undefined) {
  return Boolean(git && (git.created > 0 || git.changed > 0 || git.deleted > 0));
}
