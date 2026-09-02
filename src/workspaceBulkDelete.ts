import type { Store } from './types';

export type WorkspaceDeleteTarget = { projectId: string; workspaceId: string };

export function matchingWorkspaceDeleteTargets(store: Store, commaSeparatedNames: string): WorkspaceDeleteTarget[] {
  const terms = commaSeparatedNames
    .split(',')
    .map((term) => term.trim().toLocaleLowerCase())
    .filter(Boolean);

  if (terms.length === 0) return [];

  return store.projects.flatMap((project) => project.workspaces
    .filter((workspace) => terms.some((term) => workspace.name.toLocaleLowerCase().includes(term)))
    .map((workspace) => ({ projectId: project.id, workspaceId: workspace.id })));
}
