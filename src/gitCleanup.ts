import type { Project, WorkspaceEntry } from './types';

export type GitCleanupCandidate = {
  path: string;
  branch: string;
  merged_via: string;
  missing: boolean;
};

export type GitCleanupPlan = {
  default_branch: string;
  candidates: GitCleanupCandidate[];
  warnings: string[];
};

export type GitCleanupResult = {
  removed_paths: string[];
  deleted_branches: string[];
  warnings: string[];
};

export function workspacesForWorktreePaths(project: Project, paths: string[]): WorkspaceEntry[] {
  return project.workspaces.filter((workspace) => {
    const cwd = normalizePath(workspace.cwd);
    return cwd !== null && paths.some((path) => {
      const worktreePath = normalizePath(path);
      return worktreePath !== null && (cwd === worktreePath || cwd.startsWith(`${worktreePath}/`));
    });
  });
}

export function cleanupConfirmationMessage(project: Project, plan: GitCleanupPlan) {
  const workspaces = workspacesForWorktreePaths(project, plan.candidates.map((candidate) => candidate.path));
  const lines = plan.candidates.map((candidate) => `• ${candidate.branch}\n  ${candidate.path}`);
  return [
    `Clean up ${plan.candidates.length} merged worktree${plan.candidates.length === 1 ? '' : 's'} in ${project.name}?`,
    '',
    ...lines,
    '',
    `${workspaces.length} associated Stacks workspace${workspaces.length === 1 ? '' : 's'} will be deleted.`,
    'Dirty worktrees are never included.',
  ].join('\n');
}

function normalizePath(path: string | null | undefined) {
  const normalized = path?.trim().replace(/\/+$/, '');
  return normalized || null;
}
