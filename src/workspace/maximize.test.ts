import { describe, expect, it } from 'vitest';
import { nextPaneIdForCycle, shouldClearMaximizedTerminalAfterClose, toggleMaximizedTerminalId } from './maximize';

describe('workspace maximize helpers', () => {
  it('cycles pane focus with wraparound', () => {
    expect(nextPaneIdForCycle(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(nextPaneIdForCycle(['a', 'b', 'c'], 'a', -1)).toBe('c');
  });

  it('falls back to the first pane when current pane is unknown', () => {
    expect(nextPaneIdForCycle(['a', 'b'], 'missing', 1)).toBe('b');
    expect(nextPaneIdForCycle([], 'missing', 1)).toBeNull();
  });

  it('toggles maximized terminal state at terminal granularity', () => {
    expect(toggleMaximizedTerminalId(null, 'term')).toBe('term');
    expect(toggleMaximizedTerminalId('other', 'term')).toBe('term');
    expect(toggleMaximizedTerminalId('term', 'term')).toBeNull();
  });

  it('clears maximized terminal when only one pane remains', () => {
    expect(shouldClearMaximizedTerminalAfterClose(0)).toBe(true);
    expect(shouldClearMaximizedTerminalAfterClose(1)).toBe(true);
    expect(shouldClearMaximizedTerminalAfterClose(2)).toBe(false);
  });
});
