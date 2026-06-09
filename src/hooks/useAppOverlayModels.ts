import { useMemo } from 'react';
import type { Store } from '../types';

export type ConfirmDeleteTerminalState = { projectId: string; terminalId: string };

export function useAppOverlayModels({
  store,
  confirmDeleteProjectId,
  confirmDeleteTerminal,
}: {
  store: Store;
  confirmDeleteProjectId: string | null;
  confirmDeleteTerminal: ConfirmDeleteTerminalState | null;
}) {
  const confirmDeleteProject = useMemo(
    () => confirmDeleteProjectId
      ? store.projects.find((project) => project.id === confirmDeleteProjectId) ?? null
      : null,
    [store, confirmDeleteProjectId]
  );

  const confirmDeleteTerminalEntry = useMemo(
    () => confirmDeleteTerminal
      ? store.projects
        .find((project) => project.id === confirmDeleteTerminal.projectId)
        ?.terminals.find((terminal) => terminal.id === confirmDeleteTerminal.terminalId) ?? null
      : null,
    [store, confirmDeleteTerminal]
  );

  return { confirmDeleteProject, confirmDeleteTerminalEntry };
}
