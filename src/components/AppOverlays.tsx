import type React from 'react';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { Dialog } from './Dialogs';
import { SettingsDialog } from './SettingsDialog';
import { AppContextMenu } from './AppContextMenu';
import { AppConfirmDialogs } from './AppConfirmDialogs';
import { OneTimeCommandDialog } from './OneTimeCommandDialog';
import { AddCmdPCommandDialog } from './AddCmdPCommandDialog';
import { DeleteCmdPCommandDialog } from './DeleteCmdPCommandDialog';
import { WorkspaceTemplateDialog } from './WorkspaceTemplateDialog';
import { DeleteWorkspaceTemplateDialog } from './DeleteWorkspaceTemplateDialog';
import { DeleteMultipleWorkspacesDialog } from './DeleteMultipleWorkspacesDialog';
import type { ContextMenuState, CustomCmdPCommand, DialogState, Project, Store, ToastState, WorkspaceEntry, WorkspaceTemplate } from '../types';
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
  oneTimeCommandOpen,
  oneTimeCommandCwd,
  setOneTimeCommandOpen,
  addCmdPCommandOpen,
  setAddCmdPCommandOpen,
  editingCmdPCommand,
  setEditingCmdPCommand,
  deletingCmdPCommand,
  setDeletingCmdPCommand,
  addCmdPCommand,
  editCmdPCommand,
  deleteCmdPCommand,
  addWorkspaceTemplateOpen,
  setAddWorkspaceTemplateOpen,
  editingWorkspaceTemplate,
  setEditingWorkspaceTemplate,
  deletingWorkspaceTemplate,
  setDeletingWorkspaceTemplate,
  addWorkspaceTemplate,
  editWorkspaceTemplate,
  deleteWorkspaceTemplate,
  deleteMultipleWorkspacesOpen,
  setDeleteMultipleWorkspacesOpen,
  deleteMultipleWorkspaces,
  runOneTimeCommand,
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
  oneTimeCommandOpen: boolean;
  oneTimeCommandCwd: string | null;
  setOneTimeCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
  addCmdPCommandOpen: boolean;
  setAddCmdPCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingCmdPCommand: CustomCmdPCommand | null;
  setEditingCmdPCommand: React.Dispatch<React.SetStateAction<CustomCmdPCommand | null>>;
  deletingCmdPCommand: CustomCmdPCommand | null;
  setDeletingCmdPCommand: React.Dispatch<React.SetStateAction<CustomCmdPCommand | null>>;
  addCmdPCommand: (command: Omit<CustomCmdPCommand, 'id'>) => void;
  editCmdPCommand: (command: Omit<CustomCmdPCommand, 'id'>) => void;
  deleteCmdPCommand: () => void;
  addWorkspaceTemplateOpen: boolean;
  setAddWorkspaceTemplateOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingWorkspaceTemplate: WorkspaceTemplate | null;
  setEditingWorkspaceTemplate: React.Dispatch<React.SetStateAction<WorkspaceTemplate | null>>;
  deletingWorkspaceTemplate: WorkspaceTemplate | null;
  setDeletingWorkspaceTemplate: React.Dispatch<React.SetStateAction<WorkspaceTemplate | null>>;
  addWorkspaceTemplate: (template: Omit<WorkspaceTemplate, 'id'>) => void;
  editWorkspaceTemplate: (template: Omit<WorkspaceTemplate, 'id'>) => void;
  deleteWorkspaceTemplate: () => void;
  deleteMultipleWorkspacesOpen: boolean;
  setDeleteMultipleWorkspacesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  deleteMultipleWorkspaces: (query: string) => void;
  runOneTimeCommand: (command: string) => Promise<boolean>;
  dialog: DialogState | null;
  confirmCloseTerminalId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspace | null;
  confirmDeleteWorkspaceEntry: WorkspaceEntry | null;
  confirmQuitOpen: boolean;
  toast: ToastState | null;
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
  openEditWorkspaceDialog: (project: Project, workspace: WorkspaceEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => Promise<boolean>;
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
      <AddCmdPCommandDialog
        open={addCmdPCommandOpen}
        onCancel={() => {
          setAddCmdPCommandOpen(false);
          restoreActiveTerminalFocus('cancel-add-cmd-p-command');
        }}
        onSave={addCmdPCommand}
      />
      <AddCmdPCommandDialog
        open={Boolean(editingCmdPCommand)}
        commandToEdit={editingCmdPCommand}
        onCancel={() => {
          setEditingCmdPCommand(null);
          restoreActiveTerminalFocus('cancel-edit-cmd-p-command');
        }}
        onSave={editCmdPCommand}
      />
      <DeleteCmdPCommandDialog
        command={deletingCmdPCommand}
        onCancel={() => {
          setDeletingCmdPCommand(null);
          restoreActiveTerminalFocus('cancel-delete-cmd-p-command');
        }}
        onDelete={deleteCmdPCommand}
      />
      <WorkspaceTemplateDialog
        open={addWorkspaceTemplateOpen}
        onCancel={() => {
          setAddWorkspaceTemplateOpen(false);
          restoreActiveTerminalFocus('cancel-add-workspace-template');
        }}
        onSave={addWorkspaceTemplate}
      />
      <WorkspaceTemplateDialog
        open={Boolean(editingWorkspaceTemplate)}
        templateToEdit={editingWorkspaceTemplate}
        onCancel={() => {
          setEditingWorkspaceTemplate(null);
          restoreActiveTerminalFocus('cancel-edit-workspace-template');
        }}
        onSave={editWorkspaceTemplate}
      />
      <DeleteWorkspaceTemplateDialog
        template={deletingWorkspaceTemplate}
        onCancel={() => {
          setDeletingWorkspaceTemplate(null);
          restoreActiveTerminalFocus('cancel-delete-workspace-template');
        }}
        onDelete={deleteWorkspaceTemplate}
      />
      <DeleteMultipleWorkspacesDialog
        open={deleteMultipleWorkspacesOpen}
        onCancel={() => {
          setDeleteMultipleWorkspacesOpen(false);
          restoreActiveTerminalFocus('cancel-delete-multiple-workspaces');
        }}
        onDelete={deleteMultipleWorkspaces}
      />
      <OneTimeCommandDialog
        open={oneTimeCommandOpen}
        cwd={oneTimeCommandCwd}
        onCancel={() => {
          setOneTimeCommandOpen(false);
          restoreActiveTerminalFocus('cancel-one-time-command');
        }}
        onRun={(command) => {
          setOneTimeCommandOpen(false);
          runOneTimeCommand(command).catch((error) => console.error('one-time command failed', error));
        }}
      />
      {dialog && <Dialog dialog={dialog} setDialog={setDialog} onCancel={closeDialog} onSubmit={submitActiveDialog} />}
      {toast && (
        <div
          className="toast"
          style={toast.x !== undefined && toast.y !== undefined ? { left: toast.x, top: toast.y } : undefined}
        >
          {toast.message}
        </div>
      )}
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
