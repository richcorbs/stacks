import { describe, expect, it } from 'vitest';
import type React from 'react';
import { saveTerminalSplitToStore } from './saveTerminalSplit';
import type { Store } from '../types';

function applySave(store: Store, terminalId: string, root: Parameters<typeof saveTerminalSplitToStore>[2]) {
  let nextStore = store;
  const setStore: React.Dispatch<React.SetStateAction<Store>> = (next) => {
    nextStore = typeof next === 'function' ? next(nextStore) : next;
  };
  saveTerminalSplitToStore(setStore, terminalId, root);
  return nextStore;
}

describe('saveTerminalSplitToStore', () => {
  it('normalizes and persists split roots for the selected terminal only', () => {
    const store: Store = {
      projects: [{
        id: 'p1',
        name: 'Project',
        path: '/repo',
        terminals: [
          { id: 't1', name: 'One' },
          { id: 't2', name: 'Two', splits: { kind: 'leaf', paneId: 't2:0' } },
        ],
      }],
    };

    const result = applySave(store, 't1', {
      kind: 'split',
      direction: 'row',
      ratio: 0.4,
      manual: false,
      first: { kind: 'leaf', paneId: 't1:0', command: undefined },
      second: { kind: 'empty' },
    });

    expect(result.projects[0].terminals[0].splits).toEqual({
      kind: 'leaf',
      paneId: 't1:0',
      command: undefined,
    });
    expect(result.projects[0].terminals[1].splits).toEqual({ kind: 'leaf', paneId: 't2:0' });
  });

  it('stores null when the root is empty', () => {
    const result = applySave({ projects: [{ id: 'p1', name: 'Project', path: '/repo', terminals: [{ id: 't1', name: 'One' }] }] }, 't1', { kind: 'empty' });
    expect(result.projects[0].terminals[0].splits).toBeNull();
  });
});
