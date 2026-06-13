import { useMemo } from 'react';
import type { TerminalEntry, Project, SplitNode, Store, WorkspaceEntry } from '../types';

type WorkspaceViewModel = {
  project: Project;
  workspace: WorkspaceEntry;
  terminals: TerminalEntry[];
  root: SplitNode | undefined;
};

export function useAppWorkspaceModels({
  store,
  activeProjectId,
  activeWorkspaceId,
  activeTerminalId,
  terminalCwds,
  visitedWorkspaceIds,
  terminalsByWorkspaceId,
  splitRootsByWorkspaceId,
}: {
  store: Store;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  terminalCwds: Record<string, string>;
  visitedWorkspaceIds: string[];
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
}) {
  const activeProject = useMemo(
    () => store.projects.find((p) => p.id === activeProjectId) ?? null,
    [store, activeProjectId]
  );
  const activeWorkspace = useMemo(
    () => activeProject?.workspaces.find((t) => t.id === activeWorkspaceId) ?? null,
    [activeProject, activeWorkspaceId]
  );
  const sidebarWorkspaces = useMemo(
    () => store.projects.flatMap((project) => project.workspaces.map((terminal) => ({ project, terminal }))),
    [store]
  );
  const activePath = (activeTerminalId && terminalCwds[activeTerminalId]) || activeWorkspace?.cwd || activeProject?.path || null;
  const visitedWorkspaceTerminalTrees = useMemo<WorkspaceViewModel[]>(() => visitedWorkspaceIds.flatMap((workspaceId) => {
    for (const project of store.projects) {
      const workspace = project.workspaces.find((t) => t.id === workspaceId);
      if (workspace) return [{ project, workspace, terminals: terminalsByWorkspaceId[workspaceId] ?? [], root: splitRootsByWorkspaceId[workspaceId] }];
    }
    return [];
  }), [visitedWorkspaceIds, store, terminalsByWorkspaceId, splitRootsByWorkspaceId]);

  return { activeProject, activeWorkspace, sidebarWorkspaces, activePath, visitedWorkspaceTerminalTrees };
}
