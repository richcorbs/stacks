import { ContextMenu } from './ContextMenu';
import type { ContextMenuState, Project, Store, TerminalEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';

type ConfirmDeleteTerminal = { projectId: string; terminalId: string };

export function AppContextMenu({
  contextMenu,
  store,
  appSettings,
  activeProjectId,
  activeTerminalId,
  closeContextMenu,
  openTerminalDialog,
  openEditProjectDialog,
  openEditTerminalDialog,
  setConfirmDeleteProjectId,
  setConfirmDeleteTerminal,
  deleteProject,
  deleteTerminal,
  restoreActivePaneFocus,
}: {
  contextMenu: ContextMenuState | null;
  store: Store;
  appSettings: ResolvedAppSettings;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  openTerminalDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditTerminalDialog: (project: Project, terminal: TerminalEntry) => void;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteTerminal: React.Dispatch<React.SetStateAction<ConfirmDeleteTerminal | null>>;
  deleteProject: (projectId: string) => void;
  deleteTerminal: (projectId: string, terminalId: string) => void;
  restoreActivePaneFocus: (reason: string) => void;
}) {
  if (!contextMenu) return null;

  return (
    <ContextMenu
      menu={contextMenu}
      store={store}
      onClose={() => closeContextMenu()}
      onNewTerminal={(project) => { closeContextMenu({ restoreFocus: false }); openTerminalDialog(project); }}
      onEditProject={(project) => { closeContextMenu({ restoreFocus: false }); openEditProjectDialog(project); }}
      onDeleteProject={(project) => {
        closeContextMenu({ restoreFocus: false });
        if (appSettings.confirm_delete) {
          setConfirmDeleteProjectId(project.id);
        } else {
          const deletingActiveProject = project.id === activeProjectId;
          deleteProject(project.id);
          if (!deletingActiveProject) restoreActivePaneFocus('delete-inactive-project');
        }
      }}
      onEditTerminal={(project, terminal) => { closeContextMenu({ restoreFocus: false }); openEditTerminalDialog(project, terminal); }}
      onDeleteTerminal={(project, terminal) => {
        closeContextMenu({ restoreFocus: false });
        if (appSettings.confirm_delete) {
          setConfirmDeleteTerminal({ projectId: project.id, terminalId: terminal.id });
        } else {
          const deletingActiveTerminal = terminal.id === activeTerminalId;
          deleteTerminal(project.id, terminal.id);
          if (!deletingActiveTerminal) restoreActivePaneFocus('delete-inactive-workspace');
        }
      }}
    />
  );
}
