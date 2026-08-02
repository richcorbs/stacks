import { describe, expect, it } from 'vitest';
import type { Store } from '../types';
import { planWorkspaceCreation } from './createWorkspace';

const store: Store = {
  projects: [{ id: 'project-1', name: 'Project', path: '/repo', workspaces: [], collapsed: true }],
};

describe('planWorkspaceCreation', () => {
  it('creates a persisted one-terminal workspace plan', () => {
    const result = planWorkspaceCreation(store, {
      projectId: 'project-1',
      name: ' API work ',
      command: ' npm run dev ',
    }, 'workspace-1');

    expect(result.workspace).toEqual({
      id: 'workspace-1',
      name: 'API work',
      command: 'npm run dev',
      cwd: '/repo',
      splits: { kind: 'leaf', terminalId: 'workspace-1:0' },
    });
    expect(result.terminals).toEqual([{ id: 'workspace-1:0', workspaceId: 'workspace-1', command: null }]);
    expect(result.store.projects[0].collapsed).toBe(false);
    expect(result.store.projects[0].workspaces).toEqual([result.workspace]);
  });

  it('creates a requested terminal grid', () => {
    const result = planWorkspaceCreation(store, {
      projectId: 'project-1',
      name: 'Grid',
      rows: 2,
      columns: 3,
    }, 'workspace-1');

    expect(result.terminals).toHaveLength(6);
    expect(result.root.kind).toBe('split');
  });

  it('does not persist a one-time startup command', () => {
    const result = planWorkspaceCreation(store, {
      projectId: 'project-1',
      name: 'One-off',
      oneTimeStartupCommand: 'npm test',
    }, 'workspace-1');

    expect(result.workspace.command).toBeNull();
  });

  it('rejects a missing project', () => {
    expect(() => planWorkspaceCreation(store, {
      projectId: 'missing',
      name: 'Workspace',
    }, 'workspace-1')).toThrow('The selected project no longer exists');
  });
});
