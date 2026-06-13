import type React from 'react';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { Dialog } from './Dialogs';
import { SettingsDialog } from './SettingsDialog';
import { AppContextMenu } from './AppContextMenu';
import { AppConfirmDialogs } from './AppConfirmDialogs';
import type { ContextMenuState, DialogState, Project, Store, WorkspaceEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';

type ConfirmDeleteWorkspace = { projectId: string; workspaceId: string };

export function AppOverlays({
  store,
  appSettings,
  setAppSettings,
  contextMenu,
  commandPaletteOpen,
  commandPaletteItems,
  settingsOpen,
  dialog,
  confirmCloseTerminalId,
  confirmDeleteProject,
  confirmDeleteWorkspace,
  confirmDeleteWorkspaceEntry,
  confirmQuitOpen,
  toast,
  activeProjectId,
  activeWorkspaceId,
  setDialog,
  setConfirmCloseTerminalId,
  setConfirmDeleteProjectId,
  setConfirmDeleteWorkspace,
  setConfirmQuitOpen,
  closeContextMenu,
  closeCommandPalette,
  closeSettings,
  closeDialog,
  submitActiveDialog,
  openWorkspaceDialog,
  openEditProjectDialog,
  openEditWorkspaceDialog,
  deleteProject,
  deleteWorkspace,
  closeTerminal,
  restoreActiveTerminalFocus,
}: {
  store: Store;
  appSettings: ResolvedAppSettings;
  setAppSettings: (settings: ResolvedAppSettings) => void;
  contextMenu: ContextMenuState | null;
  commandPaletteOpen: boolean;
  commandPaletteItems: PaletteItem[];
  settingsOpen: boolean;
  dialog: DialogState | null;
  confirmCloseTerminalId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspace | null;
  confirmDeleteWorkspaceEntry: WorkspaceEntry | null;
  confirmQuitOpen: boolean;
  toast: string | null;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteWorkspace: React.Dispatch<React.SetStateAction<ConfirmDeleteWorkspace | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openWorkspaceDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditWorkspaceDialog: (project: Project, terminal: WorkspaceEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => void;
  closeTerminal: (terminalId: string) => void;
  restoreActiveTerminalFocus: (reason: string) => void;
}) {
  return (
    <>
      <AppContextMenu
        contextMenu={contextMenu}
        store={store}
        appSettings={appSettings}
        activeProjectId={activeProjectId}
        activeWorkspaceId={activeWorkspaceId}
        closeContextMenu={closeContextMenu}
        openWorkspaceDialog={openWorkspaceDialog}
        openEditProjectDialog={openEditProjectDialog}
        openEditWorkspaceDialog={openEditWorkspaceDialog}
        setConfirmDeleteProjectId={setConfirmDeleteProjectId}
        setConfirmDeleteWorkspace={setConfirmDeleteWorkspace}
        deleteProject={deleteProject}
        deleteWorkspace={deleteWorkspace}
        restoreActiveTerminalFocus={restoreActiveTerminalFocus}
      />
      <CommandPalette
        open={commandPaletteOpen}
        items={commandPaletteItems}
        onClose={() => closeCommandPalette()}
        onRunItem={() => closeCommandPalette({ restoreFocus: false })}
      />
      {settingsOpen && <SettingsDialog settings={appSettings} onChange={setAppSettings} onClose={closeSettings} />}
      {dialog && <Dialog dialog={dialog} setDialog={setDialog} onCancel={closeDialog} onSubmit={submitActiveDialog} />}
      {toast && <div className="toast">{toast}</div>}
      <AppConfirmDialogs
        confirmCloseTerminalId={confirmCloseTerminalId}
        confirmDeleteProject={confirmDeleteProject}
        confirmDeleteWorkspace={confirmDeleteWorkspace}
        confirmDeleteWorkspaceEntry={confirmDeleteWorkspaceEntry}
        confirmQuitOpen={confirmQuitOpen}
        activeProjectId={activeProjectId}
        activeWorkspaceId={activeWorkspaceId}
        setConfirmCloseTerminalId={setConfirmCloseTerminalId}
        setConfirmDeleteProjectId={setConfirmDeleteProjectId}
        setConfirmDeleteWorkspace={setConfirmDeleteWorkspace}
        setConfirmQuitOpen={setConfirmQuitOpen}
        closeTerminal={closeTerminal}
        deleteProject={deleteProject}
        deleteWorkspace={deleteWorkspace}
        restoreActiveTerminalFocus={restoreActiveTerminalFocus}
      />
    </>
  );
}
