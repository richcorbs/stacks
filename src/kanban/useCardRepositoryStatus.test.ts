import { describe, expect, it } from 'vitest';
import { environmentHealthTooltip, hasGitChanges, healthCheckFailure } from './useCardRepositoryStatus';
import type { KanbanCard } from './types';

describe('card repository status', () => {
  it('only reports a Git status when the worktree has changes', () => {
    expect(hasGitChanges({ branch: 'main', created: 0, changed: 0, deleted: 0 })).toBe(false);
    expect(hasGitChanges({ branch: 'feature', created: 0, changed: 2, deleted: 0 })).toBe(true);
    expect(hasGitChanges(null)).toBe(false);
  });

  it('builds accessible warning text from every blocker and affected step', () => {
    expect(environmentHealthTooltip({ card_id: '1', issues: [
      { code: 'source_missing', message: 'The source checkout is missing.', step: 'work' },
      { code: 'target_wrong', message: 'The target branch changed.', step: 'merge' },
    ] })).toBe('The source checkout is missing. Affects work. The target branch changed. Affects merge.');
    expect(environmentHealthTooltip({ card_id: '1', issues: [] })).toBe('');
  });

  it('turns unexpected checks into status-aware diagnostic issues', () => {
    const card = (status: KanbanCard['status']) => ({ id: 'local:1', status }) as KanbanCard;
    expect(healthCheckFailure(card('needs_human'), new Error('offline')).issues[0]).toMatchObject({
      code: 'health_check_failed', step: 'approval',
    });
    expect(healthCheckFailure(card('approved'), 'failed').issues[0].step).toBe('merge');
    expect(healthCheckFailure(card('done'), 'failed').issues[0].step).toBe('cleanup');
  });
});
