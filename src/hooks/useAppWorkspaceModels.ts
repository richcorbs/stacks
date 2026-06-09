import { useMemo } from 'react';
import type { Pane, Project, SplitNode, Store, TerminalEntry } from '../types';

type TerminalWorkspaceModel = {
  project: Project;
  terminal: TerminalEntry;
  panes: Pane[];
  root: SplitNode | undefined;
};

export function useAppWorkspaceModels({
  store,
  activeProjectId,
  activeTerminalId,
  activePaneId,
  paneCwds,
  visitedTerminalIds,
  panesByTerminalId,
  splitRootsByTerminalId,
}: {
  store: Store;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  activePaneId: string | null;
  paneCwds: Record<string, string>;
  visitedTerminalIds: string[];
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
}) {
  const activeProject = useMemo(
    () => store.projects.find((p) => p.id === activeProjectId) ?? null,
    [store, activeProjectId]
  );
  const activeTerminal = useMemo(
    () => activeProject?.terminals.find((t) => t.id === activeTerminalId) ?? null,
    [activeProject, activeTerminalId]
  );
  const sidebarTerminals = useMemo(
    () => store.projects.flatMap((project) => project.terminals.map((terminal) => ({ project, terminal }))),
    [store]
  );
  const activePath = (activePaneId && paneCwds[activePaneId]) || activeTerminal?.cwd || activeProject?.path || null;
  const visitedTerminalWorkspaces = useMemo<TerminalWorkspaceModel[]>(() => visitedTerminalIds.flatMap((terminalId) => {
    for (const project of store.projects) {
      const terminal = project.terminals.find((t) => t.id === terminalId);
      if (terminal) return [{ project, terminal, panes: panesByTerminalId[terminalId] ?? [], root: splitRootsByTerminalId[terminalId] }];
    }
    return [];
  }), [visitedTerminalIds, store, panesByTerminalId, splitRootsByTerminalId]);

  return { activeProject, activeTerminal, sidebarTerminals, activePath, visitedTerminalWorkspaces };
}
