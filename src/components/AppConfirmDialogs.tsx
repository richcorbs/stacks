import { invoke } from '@tauri-apps/api/core';
import { ConfirmClosePaneDialog, ConfirmDeleteProjectDialog, ConfirmDeleteTerminalDialog, ConfirmQuitDialog } from './ConfirmDialogs';
import type { Project, TerminalEntry } from '../types';

type ConfirmDeleteTerminal = { projectId: string; terminalId: string };

export function AppConfirmDialogs({
  confirmClosePaneId,
  confirmDeleteProject,
  confirmDeleteTerminal,
  confirmDeleteTerminalEntry,
  confirmQuitOpen,
  activeProjectId,
  activeTerminalId,
  setConfirmClosePaneId,
  setConfirmDeleteProjectId,
  setConfirmDeleteTerminal,
  setConfirmQuitOpen,
  closePane,
  deleteProject,
  deleteTerminal,
  restoreActivePaneFocus,
}: {
  confirmClosePaneId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteTerminal: ConfirmDeleteTerminal | null;
  confirmDeleteTerminalEntry: TerminalEntry | null;
  confirmQuitOpen: boolean;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  setConfirmClosePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteTerminal: React.Dispatch<React.SetStateAction<ConfirmDeleteTerminal | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closePane: (paneId: string) => void;
  deleteProject: (projectId: string) => void;
  deleteTerminal: (projectId: string, terminalId: string) => void;
  restoreActivePaneFocus: (reason: string) => void;
}) {
  return (
    <>
      {confirmClosePaneId && (
        <ConfirmClosePaneDialog
          onCancel={() => {
            setConfirmClosePaneId(null);
            restoreActivePaneFocus('cancel-close-pane');
          }}
          onConfirm={() => {
            const paneId = confirmClosePaneId;
            setConfirmClosePaneId(null);
            closePane(paneId);
          }}
        />
      )}
      {confirmDeleteProject && (
        <ConfirmDeleteProjectDialog
          projectName={confirmDeleteProject.name}
          onCancel={() => {
            setConfirmDeleteProjectId(null);
            restoreActivePaneFocus('cancel-delete-project');
          }}
          onConfirm={() => {
            const projectId = confirmDeleteProject.id;
            const deletingActiveProject = projectId === activeProjectId;
            setConfirmDeleteProjectId(null);
            deleteProject(projectId);
            if (!deletingActiveProject) restoreActivePaneFocus('delete-inactive-project');
          }}
        />
      )}
      {confirmDeleteTerminal && confirmDeleteTerminalEntry && (
        <ConfirmDeleteTerminalDialog
          terminalName={confirmDeleteTerminalEntry.name}
          onCancel={() => {
            setConfirmDeleteTerminal(null);
            restoreActivePaneFocus('cancel-delete-workspace');
          }}
          onConfirm={() => {
            const { projectId, terminalId } = confirmDeleteTerminal;
            const deletingActiveTerminal = terminalId === activeTerminalId;
            setConfirmDeleteTerminal(null);
            deleteTerminal(projectId, terminalId);
            if (!deletingActiveTerminal) restoreActivePaneFocus('delete-inactive-workspace');
          }}
        />
      )}
      {confirmQuitOpen && (
        <ConfirmQuitDialog
          onCancel={() => {
            setConfirmQuitOpen(false);
            restoreActivePaneFocus('cancel-quit');
          }}
          onConfirm={() => {
            setConfirmQuitOpen(false);
            invoke('save_current_window_state')
              .catch(console.error)
              .finally(() => invoke('quit_app').catch(console.error));
          }}
        />
      )}
    </>
  );
}
