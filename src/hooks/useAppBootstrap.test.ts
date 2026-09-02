import { describe, expect, it } from 'vitest';
import type { Store } from '../types';
import { restoredWorkspaceSelection } from './useAppBootstrap';

const store: Store = {
  projects: [
    { id: 'p1', name: 'One', path: '/one', workspaces: [{ id: 'w1', name: 'First' }] },
    { id: 'p2', name: 'Two', path: '/two', workspaces: [{ id: 'w2', name: 'Second' }] },
  ],
};

describe('restoredWorkspaceSelection', () => {
  it('restores a valid active project and workspace', () => {
    expect(restoredWorkspaceSelection(store, { active_project_id: 'p2', active_workspace_id: 'w2' }))
      .toEqual({ projectId: 'p2', workspaceId: 'w2' });
  });

  it('falls back safely when persisted ids no longer exist', () => {
    expect(restoredWorkspaceSelection(store, { active_project_id: 'missing', active_workspace_id: 'missing' }))
      .toEqual({ projectId: 'p1', workspaceId: null });
  });

  it('handles an empty store', () => {
    expect(restoredWorkspaceSelection({ projects: [] }, null)).toEqual({ projectId: null, workspaceId: null });
  });
});
