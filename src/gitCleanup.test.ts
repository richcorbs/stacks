import { describe, expect, it } from 'vitest';
import { cleanupConfirmationMessage, workspacesForWorktreePaths, type GitCleanupPlan } from './gitCleanup';
import type { Project } from './types';

const project: Project = {
  id: 'p1',
  name: 'App',
  path: '/code/app',
  workspaces: [
    { id: 'main', name: 'Main', cwd: '/code/app' },
    { id: 'card', name: 'Card', cwd: '/code/app-st-123/packages/web' },
    { id: 'other', name: 'Other', cwd: '/code/app-st-1234' },
  ],
};

const plan: GitCleanupPlan = {
  default_branch: 'main',
  candidates: [{ path: '/code/app-st-123', branch: 'feature/123', merged_via: 'GitHub PR', missing: false }],
  warnings: [],
};

describe('Git cleanup workspace matching', () => {
  it('matches worktree roots and their subdirectories without matching path prefixes', () => {
    expect(workspacesForWorktreePaths(project, ['/code/app-st-123']).map((workspace) => workspace.id)).toEqual(['card']);
  });

  it('describes the destructive cleanup before confirmation', () => {
    expect(cleanupConfirmationMessage(project, plan)).toContain('Clean up 1 merged worktree in App?');
    expect(cleanupConfirmationMessage(project, plan)).toContain('1 associated Stacks workspace will be deleted.');
  });
});
