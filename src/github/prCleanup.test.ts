import { describe, expect, it } from 'vitest';
import type { GithubPullRequest } from './types';
import type { Project } from '../types';
import { cleanupPiPaneId, matchingPrWorkspaces, pendingPrCleanup } from './prCleanup';

const pullRequest: GithubPullRequest = {
  number: 42,
  title: 'Feature',
  author: 'rich',
  ci_status: 'success',
  has_merge_conflicts: false,
  head_ref_name: 'feature/cleanup',
  url: 'https://example.test/42',
  draft: false,
};
const project: Project = {
  id: 'project',
  name: 'App',
  path: '/app',
  workspaces: [
    { id: 'main', name: 'Main', cwd: '/app' },
    { id: 'feature', name: 'Feature', cwd: '/worktrees/feature', splits: { kind: 'leaf', terminalId: 'feature:pi', paneKind: 'pi' } },
  ],
};

describe('PR cleanup targeting', () => {
  it('matches the PR detected for a workspace within the project', () => {
    expect(matchingPrWorkspaces(project, pullRequest, {
      feature: { number: 42, title: 'Feature', url: '', draft: false, ci_status: 'success', base_ref_name: 'main', head_ref_name: 'feature/cleanup' },
    }).map((workspace) => workspace.id)).toEqual(['feature']);
  });

  it('falls back to the PR head branch when current-PR data is unavailable', () => {
    expect(matchingPrWorkspaces(project, pullRequest, {}, { main: 'main', feature: 'feature/cleanup' })
      .map((workspace) => workspace.id)).toEqual(['feature']);
  });

  it('prefers an active runtime Pi pane and falls back to the persisted split tree', () => {
    expect(cleanupPiPaneId(project.workspaces[1], [
      { id: 'feature:pi', workspaceId: 'feature', kind: 'pi' },
      { id: 'feature:other', workspaceId: 'feature', kind: 'pi' },
    ], 'feature:other')).toBe('feature:other');
    expect(cleanupPiPaneId(project.workspaces[1], [], null)).toBe('feature:pi');
  });

  it('captures the PR and workspace association before merging', () => {
    expect(pendingPrCleanup('rich/app', pullRequest, project, project.workspaces[1], 'feature:pi')).toMatchObject({
      repository: 'rich/app',
      pullRequestNumber: 42,
      projectId: 'project',
      workspaceId: 'feature',
      paneId: 'feature:pi',
      stage: 'ready-to-merge',
    });
  });
});
