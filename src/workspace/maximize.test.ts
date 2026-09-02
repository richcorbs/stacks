import { describe, expect, it } from 'vitest';
import { nextTerminalIdForCycle, shouldClearMaximizedTerminalAfterClose, toggleMaximizedWorkspace } from './maximize';

describe('workspace maximize helpers', () => {
  it('cycles terminal focus with wraparound', () => {
    expect(nextTerminalIdForCycle(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(nextTerminalIdForCycle(['a', 'b', 'c'], 'a', -1)).toBe('c');
  });

  it('falls back to the first terminal when current terminal is unknown', () => {
    expect(nextTerminalIdForCycle(['a', 'b'], 'missing', 1)).toBe('b');
    expect(nextTerminalIdForCycle([], 'missing', 1)).toBeNull();
  });

  it('toggles maximized state independently for each workspace', () => {
    expect(toggleMaximizedWorkspace({}, 'workspace-a')).toEqual({ 'workspace-a': true });
    expect(toggleMaximizedWorkspace({ 'workspace-a': true }, 'workspace-b')).toEqual({
      'workspace-a': true,
      'workspace-b': true,
    });
    expect(toggleMaximizedWorkspace({ 'workspace-a': true, 'workspace-b': true }, 'workspace-a')).toEqual({
      'workspace-b': true,
    });
  });

  it('clears maximized terminal when only one terminal remains', () => {
    expect(shouldClearMaximizedTerminalAfterClose(0)).toBe(true);
    expect(shouldClearMaximizedTerminalAfterClose(1)).toBe(true);
    expect(shouldClearMaximizedTerminalAfterClose(2)).toBe(false);
  });
});
