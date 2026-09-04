import type React from 'react';
import type { DialogState, Project, Store, WorkspaceTemplate } from '../types';
import type { CreateWorkspace } from './createWorkspace';

export function newWorkspaceDialog(projectId: string, name: string): Extract<DialogState, { kind: 'workspace' }> {
  return { kind: 'workspace', projectId, name, command: '', setupCommand: '', rows: 1, columns: 1, firstPaneKind: 'pi' };
}

export function workspaceDialogFromTemplate(projectId: string, template: WorkspaceTemplate): Extract<DialogState, { kind: 'workspace' }> {
  return {
    ...newWorkspaceDialog(projectId, template.name),
    command: template.command,
    setupCommand: template.setupCommand,
    rows: template.rows,
    columns: template.columns,
    firstPaneKind: template.firstPaneKind,
  };
}

type SubmitWorkspaceDialogOptions = {
  dialog: DialogState | null;
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  completeSplitTerminal: (workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null, initialInput?: string, paneKind?: 'terminal' | 'pi') => Promise<void>;
  updateTerminalPane: (workspaceId: string, terminalId: string, paneKind: 'terminal' | 'pi', command: string | null) => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  createWorkspace: CreateWorkspace;
};

export async function submitWorkspaceDialog({
  dialog,
  store,
  setStore,
  setDialog,
  completeSplitTerminal,
  updateTerminalPane,
  addProject,
  createWorkspace,
}: SubmitWorkspaceDialogOptions) {
  if (!dialog) return;

  if (dialog.kind === 'project') {
    const name = dialog.name.trim();
    const path = dialog.path.trim();
    if (!name || !path) return;
    const project = await addProject(name, path);
    if (dialog.openTerminalAfterCreate) {
      setDialog(null);
      window.setTimeout(() => {
        setDialog(newWorkspaceDialog(project.id, 'Workspace 1'));
      }, 200);
    } else {
      setDialog(null);
    }
    return;
  }

  if (dialog.kind === 'split') {
    await completeSplitTerminal(dialog.workspaceId, dialog.targetTerminalId, dialog.direction, dialog.paneKind === 'terminal' ? dialog.command.trim() || null : null, undefined, dialog.paneKind);
    setDialog(null);
    return;
  }

  if (dialog.kind === 'editProject') {
    const name = dialog.name.trim();
    const path = dialog.path.trim();
    if (!name || !path) return;
    setStore((s) => ({ projects: s.projects.map((p) => p.id === dialog.projectId ? { ...p, name, path } : p) }));
    setDialog(null);
    return;
  }

  if (dialog.kind === 'editTerminal') {
    const command = dialog.paneKind === 'terminal' ? dialog.command.trim() || null : null;
    await updateTerminalPane(dialog.workspaceId, dialog.terminalId, dialog.paneKind, command);
    if (dialog.terminalId === `${dialog.workspaceId}:0`) {
      setStore((s) => ({
        projects: s.projects.map((p) => ({
          ...p,
          workspaces: p.workspaces.map((workspace) => workspace.id === dialog.workspaceId ? { ...workspace, command } : workspace),
        })),
      }));
    }
    setDialog(null);
    return;
  }

  if (dialog.kind === 'editWorkspace') {
    const name = dialog.name.trim();
    if (!name) return;
    const cwd = dialog.cwd.trim() || null;
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === dialog.projectId ? {
        ...p,
        workspaces: p.workspaces.map((workspace) => workspace.id === dialog.workspaceId ? { ...workspace, name, command: dialog.command.trim() || null, cwd } : workspace),
      } : p),
    }));
    setDialog(null);
    return;
  }

  await createWorkspace({
    projectId: dialog.projectId,
    name: dialog.name,
    command: dialog.firstPaneKind === 'terminal' ? dialog.command : '',
    setupCommand: dialog.setupCommand,
    rows: dialog.rows,
    columns: dialog.columns,
    firstPaneKind: dialog.firstPaneKind,
  });
  setDialog(null);
}
