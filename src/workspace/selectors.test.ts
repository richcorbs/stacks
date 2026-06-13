import { describe, expect, it } from 'vitest';
import type { TerminalEntry, SplitNode } from '../types';
import { effectiveDisplayedMaximizedTerminalId, terminalIdsForWorkspace, previousTerminalIdAfterClose, shouldMaximizeTerminalAfterNewSplit } from './selectors';

const terminals: Record<string, TerminalEntry[]> = {
  term: [
    { id: 'term:0', workspaceId: 'term' },
    { id: 'term:1', workspaceId: 'term' },
    { id: 'term:2', workspaceId: 'term' },
  ],
};

describe('workspace selectors', () => {
  it('uses split-tree visual terminal order when available', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', terminalId: 'term:2' },
      second: { kind: 'leaf', terminalId: 'term:0' },
    };

    expect(terminalIdsForWorkspace('term', terminals, root)).toEqual(['term:2', 'term:0']);
  });

  it('falls back to terminal state order without a split tree', () => {
    expect(terminalIdsForWorkspace('term', terminals, null)).toEqual(['term:0', 'term:1', 'term:2']);
  });

  it('returns the focused terminal when the terminal is maximized', () => {
    expect(effectiveDisplayedMaximizedTerminalId('term', 'term', 'term:0', ['term:0'])).toBeNull();
    expect(effectiveDisplayedMaximizedTerminalId('term', 'term', 'term:1', ['term:0', 'term:1'])).toBe('term:1');
    expect(effectiveDisplayedMaximizedTerminalId('term', 'term', null, ['term:0', 'term:1'])).toBe('term:0');
    expect(effectiveDisplayedMaximizedTerminalId('other', 'term', 'term:1', ['term:0', 'term:1'])).toBeNull();
  });

  it('keeps a new split maximized only when the terminal was already maximized with multiple terminals', () => {
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0'], 'term')).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], null)).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], 'other')).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], 'term')).toBe(true);
  });

  it('selects previous visual terminal after close with wraparound', () => {
    expect(previousTerminalIdAfterClose(['a', 'b', 'c'], 'b')).toBe('a');
    expect(previousTerminalIdAfterClose(['a', 'b', 'c'], 'a')).toBe('c');
    expect(previousTerminalIdAfterClose(['a'], 'a')).toBeNull();
  });
});
