import { describe, expect, it } from 'vitest';
import { insertTemporaryPane, temporaryPaneCwd } from './cardTerminalState';

const tree = { kind: 'split', direction: 'column', first: { kind: 'leaf', terminalId: 'one' }, second: { kind: 'leaf', terminalId: 'two' } } as const;
describe('card temporary terminal panes', () => {
  it('inserts beside the focused leaf and captures the exact prior layout and focus', () => {
    const result = insertTemporaryPane(tree, 'two', 'temporary');
    expect(result.run).toEqual({ terminalId: 'temporary', previousTree: tree, previousFocus: 'two' });
    expect(result.focusedPaneId).toBe('temporary');
    expect(result.maximizedPaneId).toBe('temporary');
    expect(result.tree).toMatchObject({ kind: 'split', second: { kind: 'split', direction: 'row', first: { terminalId: 'two' }, second: { terminalId: 'temporary' } } });
  });
  it('prefers live CWD and falls back to the card worktree', () => {
    expect(temporaryPaneCwd('/live', '/worktree')).toBe('/live');
    expect(temporaryPaneCwd(null, '/worktree')).toBe('/worktree');
    expect(temporaryPaneCwd(null, null)).toBeNull();
  });
});
