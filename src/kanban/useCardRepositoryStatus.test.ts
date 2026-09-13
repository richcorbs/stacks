import { describe, expect, it } from 'vitest';
import { hasGitChanges } from './useCardRepositoryStatus';

describe('card repository status', () => {
  it('only reports a Git status when the worktree has changes', () => {
    expect(hasGitChanges({ branch: 'main', created: 0, changed: 0, deleted: 0 })).toBe(false);
    expect(hasGitChanges({ branch: 'feature', created: 0, changed: 2, deleted: 0 })).toBe(true);
    expect(hasGitChanges(null)).toBe(false);
  });
});
