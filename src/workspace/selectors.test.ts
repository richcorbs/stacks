import { describe, expect, it } from 'vitest';
import type { Pane, SplitNode } from '../types';
import { effectiveDisplayedMaximizedPaneId, paneIdsForTerminal, previousPaneIdAfterClose, shouldMaximizeTerminalAfterNewSplit } from './selectors';

const panes: Record<string, Pane[]> = {
  term: [
    { id: 'term:0', terminalId: 'term' },
    { id: 'term:1', terminalId: 'term' },
    { id: 'term:2', terminalId: 'term' },
  ],
};

describe('workspace selectors', () => {
  it('uses split-tree visual pane order when available', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'term:2' },
      second: { kind: 'leaf', paneId: 'term:0' },
    };

    expect(paneIdsForTerminal('term', panes, root)).toEqual(['term:2', 'term:0']);
  });

  it('falls back to pane state order without a split tree', () => {
    expect(paneIdsForTerminal('term', panes, null)).toEqual(['term:0', 'term:1', 'term:2']);
  });

  it('returns the focused pane when the terminal is maximized', () => {
    expect(effectiveDisplayedMaximizedPaneId('term', 'term', 'term:0', ['term:0'])).toBeNull();
    expect(effectiveDisplayedMaximizedPaneId('term', 'term', 'term:1', ['term:0', 'term:1'])).toBe('term:1');
    expect(effectiveDisplayedMaximizedPaneId('term', 'term', null, ['term:0', 'term:1'])).toBe('term:0');
    expect(effectiveDisplayedMaximizedPaneId('other', 'term', 'term:1', ['term:0', 'term:1'])).toBeNull();
  });

  it('keeps a new split maximized only when the terminal was already maximized with multiple panes', () => {
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0'], 'term')).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], null)).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], 'other')).toBe(false);
    expect(shouldMaximizeTerminalAfterNewSplit('term', ['term:0', 'term:1'], 'term')).toBe(true);
  });

  it('selects previous visual pane after close with wraparound', () => {
    expect(previousPaneIdAfterClose(['a', 'b', 'c'], 'b')).toBe('a');
    expect(previousPaneIdAfterClose(['a', 'b', 'c'], 'a')).toBe('c');
    expect(previousPaneIdAfterClose(['a'], 'a')).toBeNull();
  });
});
