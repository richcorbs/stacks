import { useMemo } from 'react';
import type { Store } from '../types';

export type ConfirmDeleteWorkspaceState = { projectId: string; workspaceId: string };

export function useAppOverlayModels({
  store,
  confirmDeleteProjectId,
  confirmDeleteWorkspace,
}: {
  store: Store;
  confirmDeleteProjectId: string | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspaceState | null;
}) {
  const confirmDeleteProject = useMemo(
    () => confirmDeleteProjectId
      ? store.projects.find((project) => project.id === confirmDeleteProjectId) ?? null
      : null,
    [store, confirmDeleteProjectId]
  );

  const confirmDeleteWorkspaceEntry = useMemo(
    () => confirmDeleteWorkspace
      ? store.projects
        .find((project) => project.id === confirmDeleteWorkspace.projectId)
        ?.workspaces.find((terminal) => terminal.id === confirmDeleteWorkspace.workspaceId) ?? null
      : null,
    [store, confirmDeleteWorkspace]
  );

  return { confirmDeleteProject, confirmDeleteWorkspaceEntry };
}
