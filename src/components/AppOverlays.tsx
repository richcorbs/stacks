import type React from 'react';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { Dialog } from './Dialogs';
import { SettingsDialog } from './SettingsDialog';
import { AppContextMenu } from './AppContextMenu';
import { AppConfirmDialogs } from './AppConfirmDialogs';
import type { ContextMenuState, DialogState, Project, Store, TerminalEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';

type ConfirmDeleteTerminal = { projectId: string; terminalId: string };

export function AppOverlays({
  store,
  appSettings,
  setAppSettings,
  contextMenu,
  commandPaletteOpen,
  commandPaletteItems,
  settingsOpen,
  dialog,
  confirmClosePaneId,
  confirmDeleteProject,
  confirmDeleteTerminal,
  confirmDeleteTerminalEntry,
  confirmQuitOpen,
  toast,
  activeProjectId,
  activeTerminalId,
  setDialog,
  setConfirmClosePaneId,
  setConfirmDeleteProjectId,
  setConfirmDeleteTerminal,
  setConfirmQuitOpen,
  closeContextMenu,
  closeCommandPalette,
  closeSettings,
  closeDialog,
  submitActiveDialog,
  openTerminalDialog,
  openEditProjectDialog,
  openEditTerminalDialog,
  deleteProject,
  deleteTerminal,
  closePane,
  restoreActivePaneFocus,
}: {
  store: Store;
  appSettings: ResolvedAppSettings;
  setAppSettings: (settings: ResolvedAppSettings) => void;
  contextMenu: ContextMenuState | null;
  commandPaletteOpen: boolean;
  commandPaletteItems: PaletteItem[];
  settingsOpen: boolean;
  dialog: DialogState | null;
  confirmClosePaneId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteTerminal: ConfirmDeleteTerminal | null;
  confirmDeleteTerminalEntry: TerminalEntry | null;
  confirmQuitOpen: boolean;
  toast: string | null;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmClosePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteTerminal: React.Dispatch<React.SetStateAction<ConfirmDeleteTerminal | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openTerminalDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditTerminalDialog: (project: Project, terminal: TerminalEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteTerminal: (projectId: string, terminalId: string) => void;
  closePane: (paneId: string) => void;
  restoreActivePaneFocus: (reason: string) => void;
}) {
  return (
    <>
      <AppContextMenu
        contextMenu={contextMenu}
        store={store}
        appSettings={appSettings}
        activeProjectId={activeProjectId}
        activeTerminalId={activeTerminalId}
        closeContextMenu={closeContextMenu}
        openTerminalDialog={openTerminalDialog}
        openEditProjectDialog={openEditProjectDialog}
        openEditTerminalDialog={openEditTerminalDialog}
        setConfirmDeleteProjectId={setConfirmDeleteProjectId}
        setConfirmDeleteTerminal={setConfirmDeleteTerminal}
        deleteProject={deleteProject}
        deleteTerminal={deleteTerminal}
        restoreActivePaneFocus={restoreActivePaneFocus}
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
        confirmClosePaneId={confirmClosePaneId}
        confirmDeleteProject={confirmDeleteProject}
        confirmDeleteTerminal={confirmDeleteTerminal}
        confirmDeleteTerminalEntry={confirmDeleteTerminalEntry}
        confirmQuitOpen={confirmQuitOpen}
        activeProjectId={activeProjectId}
        activeTerminalId={activeTerminalId}
        setConfirmClosePaneId={setConfirmClosePaneId}
        setConfirmDeleteProjectId={setConfirmDeleteProjectId}
        setConfirmDeleteTerminal={setConfirmDeleteTerminal}
        setConfirmQuitOpen={setConfirmQuitOpen}
        closePane={closePane}
        deleteProject={deleteProject}
        deleteTerminal={deleteTerminal}
        restoreActivePaneFocus={restoreActivePaneFocus}
      />
    </>
  );
}
