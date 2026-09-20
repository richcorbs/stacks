import { describe, expect, it } from 'vitest';
import { temporaryPaneCwd } from './cardTerminalState';

describe('card temporary terminal panes', () => {
  it('prefers live CWD and falls back to the card worktree', () => {
    expect(temporaryPaneCwd('/live', '/worktree')).toBe('/live');
    expect(temporaryPaneCwd(null, '/worktree')).toBe('/worktree');
    expect(temporaryPaneCwd(null, null)).toBeNull();
  });
});
