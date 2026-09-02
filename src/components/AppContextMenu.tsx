import { ContextMenu } from './ContextMenu';
import type { ContextMenuState, Project, Store, WorkspaceEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';

type ConfirmDeleteWorkspace = { projectId: string; workspaceId: string };

export function AppContextMenu({
  contextMenu,
  store,
  appSettings,
  activeProjectId,
  activeWorkspaceId,
  closeContextMenu,
  openWorkspaceDialog,
  openEditProjectDialog,
  openEditWorkspaceDialog,
  setConfirmDeleteProjectId,
  setConfirmDeleteWorkspace,
  deleteProject,
  deleteWorkspace,
  restoreActiveTerminalFocus,
}: {
  contextMenu: ContextMenuState | null;
  store: Store;
  appSettings: ResolvedAppSettings;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  openWorkspaceDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditWorkspaceDialog: (project: Project, workspace: WorkspaceEntry) => void;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteWorkspace: React.Dispatch<React.SetStateAction<ConfirmDeleteWorkspace | null>>;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => void;
  restoreActiveTerminalFocus: (reason: string) => void;
}) {
  if (!contextMenu) return null;

  return (
    <ContextMenu
      menu={contextMenu}
      store={store}
      onClose={() => closeContextMenu()}
      onNewWorkspace={(project) => { closeContextMenu({ restoreFocus: false }); openWorkspaceDialog(project); }}
      onEditProject={(project) => { closeContextMenu({ restoreFocus: false }); openEditProjectDialog(project); }}
      onDeleteProject={(project) => {
        closeContextMenu({ restoreFocus: false });
        if (appSettings.confirm_delete) {
          setConfirmDeleteProjectId(project.id);
        } else {
          const deletingActiveProject = project.id === activeProjectId;
          deleteProject(project.id);
          if (!deletingActiveProject) restoreActiveTerminalFocus('delete-inactive-project');
        }
      }}
      onEditWorkspace={(project, workspace) => { closeContextMenu({ restoreFocus: false }); openEditWorkspaceDialog(project, workspace); }}
      onDeleteWorkspace={(project, workspace) => {
        closeContextMenu({ restoreFocus: false });
        if (appSettings.confirm_delete) {
          setConfirmDeleteWorkspace({ projectId: project.id, workspaceId: workspace.id });
        } else {
          const deletingActiveWorkspace = workspace.id === activeWorkspaceId;
          deleteWorkspace(project.id, workspace.id);
          if (!deletingActiveWorkspace) restoreActiveTerminalFocus('delete-inactive-workspace');
        }
      }}
    />
  );
}
