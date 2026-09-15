import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { cardLocalComparisonTarget, projectRemoteComparisonTarget, projectRemoteComparisonTargetById } from './comparisonTarget';

function project(path: string, targetBranch?: string): Project {
  return { id: path, name: path, path, workspaces: [], target_branch: targetBranch };
}

describe('Diff comparison targets', () => {
  it('uses the project remote-tracking target and defaults legacy projects to main', () => {
    expect(projectRemoteComparisonTarget(project('/repo', 'release'))).toBe('refs/remotes/origin/release');
    expect(projectRemoteComparisonTarget(project('/legacy'))).toBe('refs/remotes/origin/main');
  });

  it('uses the card environment local target without inventing missing metadata', () => {
    expect(cardLocalComparisonTarget('main')).toBe('refs/heads/main');
    expect(cardLocalComparisonTarget(null)).toBeNull();
    expect(cardLocalComparisonTarget('  ')).toBeNull();
  });

  it('uses the active project target for developer services even when its workspace is elsewhere', () => {
    const projects = [project('/code/app', 'main'), project('/worktrees/card', 'develop')];
    expect(projectRemoteComparisonTargetById(projects, '/code/app')).toBe('refs/remotes/origin/main');
    expect(projectRemoteComparisonTargetById(projects, '/worktrees/card')).toBe('refs/remotes/origin/develop');
    expect(projectRemoteComparisonTargetById(projects, null)).toBeNull();
  });
});
