import type { Project } from '../types';

export function projectRemoteComparisonTarget(project: Pick<Project, 'target_branch'>): string {
  return `refs/remotes/origin/${project.target_branch?.trim() || 'main'}`;
}

export function cardLocalComparisonTarget(targetBranch: string | null | undefined): string | null {
  const branch = targetBranch?.trim();
  return branch ? `refs/heads/${branch}` : null;
}

export function projectRemoteComparisonTargetById(projects: Project[], projectId: string | null): string | null {
  const project = projects.find((candidate) => candidate.id === projectId);
  return project ? projectRemoteComparisonTarget(project) : null;
}
