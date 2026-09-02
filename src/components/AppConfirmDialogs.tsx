import { invoke } from '@tauri-apps/api/core';
import { ConfirmCloseTerminalDialog, ConfirmDeleteProjectDialog, ConfirmDeleteWorkspaceDialog, ConfirmQuitDialog } from './ConfirmDialogs';
import type { Project, WorkspaceEntry } from '../types';

type ConfirmDeleteWorkspace = { projectId: string; workspaceId: string };

export function AppConfirmDialogs({
  confirmCloseTerminalId,
  confirmDeleteProject,
  confirmDeleteWorkspace,
  confirmDeleteWorkspaceEntry,
  confirmQuitOpen,
  activeProjectId,
  activeWorkspaceId,
  setConfirmCloseTerminalId,
  setConfirmDeleteProjectId,
  setConfirmDeleteWorkspace,
  setConfirmQuitOpen,
  closeTerminal,
  deleteProject,
  deleteWorkspace,
  restoreActiveTerminalFocus,
}: {
  confirmCloseTerminalId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspace | null;
  confirmDeleteWorkspaceEntry: WorkspaceEntry | null;
  confirmQuitOpen: boolean;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteWorkspace: React.Dispatch<React.SetStateAction<ConfirmDeleteWorkspace | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeTerminal: (terminalId: string) => void;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => void;
  restoreActiveTerminalFocus: (reason: string) => void;
}) {
  return (
    <>
      {confirmCloseTerminalId && (
        <ConfirmCloseTerminalDialog
          onCancel={() => {
            setConfirmCloseTerminalId(null);
            restoreActiveTerminalFocus('cancel-close-terminal');
          }}
          onConfirm={() => {
            const terminalId = confirmCloseTerminalId;
            setConfirmCloseTerminalId(null);
            closeTerminal(terminalId);
          }}
        />
      )}
      {confirmDeleteProject && (
        <ConfirmDeleteProjectDialog
          projectName={confirmDeleteProject.name}
          onCancel={() => {
            setConfirmDeleteProjectId(null);
            restoreActiveTerminalFocus('cancel-delete-project');
          }}
          onConfirm={() => {
            const projectId = confirmDeleteProject.id;
            const deletingActiveProject = projectId === activeProjectId;
            setConfirmDeleteProjectId(null);
            deleteProject(projectId);
            if (!deletingActiveProject) restoreActiveTerminalFocus('delete-inactive-project');
          }}
        />
      )}
      {confirmDeleteWorkspace && confirmDeleteWorkspaceEntry && (
        <ConfirmDeleteWorkspaceDialog
          terminalName={confirmDeleteWorkspaceEntry.name}
          onCancel={() => {
            setConfirmDeleteWorkspace(null);
            restoreActiveTerminalFocus('cancel-delete-workspace');
          }}
          onConfirm={() => {
            const { projectId, workspaceId } = confirmDeleteWorkspace;
            const deletingActiveWorkspace = workspaceId === activeWorkspaceId;
            setConfirmDeleteWorkspace(null);
            deleteWorkspace(projectId, workspaceId);
            if (!deletingActiveWorkspace) restoreActiveTerminalFocus('delete-inactive-workspace');
          }}
        />
      )}
      {confirmQuitOpen && (
        <ConfirmQuitDialog
          onCancel={() => {
            setConfirmQuitOpen(false);
            restoreActiveTerminalFocus('cancel-quit');
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
