import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { DialogState, Project, Store, WorkspaceEntry } from '../types';

type SubmitWorkspaceDialogOptions = {
  dialog: DialogState | null;
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  completeSplitTerminal: (workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null) => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
};

export async function submitWorkspaceDialog({
  dialog,
  store,
  setStore,
  setDialog,
  selectWorkspace,
  setSidebarFocusedWorkspaceId,
  completeSplitTerminal,
  addProject,
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
        setDialog({ kind: 'workspace', projectId: project.id, name: 'Workspace 1', command: '' });
      }, 200);
    } else {
      setDialog(null);
    }
    return;
  }

  if (dialog.kind === 'split') {
    await completeSplitTerminal(dialog.workspaceId, dialog.targetTerminalId, dialog.direction, dialog.command.trim() || null);
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

  if (dialog.kind === 'editWorkspace') {
    const name = dialog.name.trim();
    if (!name) return;
    const cwd = dialog.cwd.trim() || null;
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === dialog.projectId ? {
        ...p,
        workspaces: p.workspaces.map((t) => t.id === dialog.workspaceId ? { ...t, name, command: dialog.command.trim() || null, cwd } : t),
      } : p),
    }));
    setDialog(null);
    return;
  }

  const project = store.projects.find((p) => p.id === dialog.projectId);
  if (!project) return;
  const name = dialog.name.trim();
  if (!name) return;
  const id = await invoke<string>('new_id');
  const terminal: WorkspaceEntry = { id, name, command: dialog.command.trim() || null, cwd: project.path };
  setStore((s) => ({
    projects: s.projects.map((p) => p.id === project.id ? { ...p, collapsed: false, workspaces: [...p.workspaces, terminal] } : p),
  }));
  selectWorkspace(project.id, id);
  setSidebarFocusedWorkspaceId(id);
  setDialog(null);
}
