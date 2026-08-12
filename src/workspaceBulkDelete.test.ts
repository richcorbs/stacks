import { describe, expect, it } from 'vitest';
import { matchingWorkspaceDeleteTargets } from './workspaceBulkDelete';
import type { Store } from './types';

const store: Store = {
  projects: [
    {
      id: 'p1',
      name: 'Project',
      path: '/project',
      workspaces: [
        { id: 'w1', name: '1776 create the thing' },
        { id: 'w2', name: 'Fix Login' },
        { id: 'w3', name: 'Keep this' },
      ],
    },
  ],
};

describe('matchingWorkspaceDeleteTargets', () => {
  it('matches comma-separated partial workspace names case-insensitively', () => {
    expect(matchingWorkspaceDeleteTargets(store, '1776, login')).toEqual([
      { projectId: 'p1', workspaceId: 'w1' },
      { projectId: 'p1', workspaceId: 'w2' },
    ]);
  });

  it('ignores empty terms', () => {
    expect(matchingWorkspaceDeleteTargets(store, ' , ')).toEqual([]);
  });
});
