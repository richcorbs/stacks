import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { DialogState, Project, SplitNode, Store, TerminalEntry, WorkspaceEntry } from '../types';
import { buildGridSplit, setLeafCommand } from '../utils';

type SubmitWorkspaceDialogOptions = {
  dialog: DialogState | null;
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  completeSplitTerminal: (workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null) => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  saveTerminalSplit: (workspaceId: string, root: SplitNode | null) => void;
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
  setTerminalsByWorkspaceId,
  splitRootsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  saveTerminalSplit,
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
        setDialog({ kind: 'workspace', projectId: project.id, name: 'Workspace 1', command: '', rows: 1, columns: 1 });
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

  if (dialog.kind === 'editTerminal') {
    const command = dialog.command.trim() || null;
    setTerminalsByWorkspaceId((all) => ({
      ...all,
      [dialog.workspaceId]: (all[dialog.workspaceId] ?? []).map((terminal) => terminal.id === dialog.terminalId ? { ...terminal, command } : terminal),
    }));
    setSplitRootsByWorkspaceId((all) => {
      const root = all[dialog.workspaceId] ?? splitRootsByWorkspaceId[dialog.workspaceId];
      if (!root) return all;
      const nextRoot = setLeafCommand(root, dialog.terminalId, command);
      saveTerminalSplit(dialog.workspaceId, nextRoot);
      return { ...all, [dialog.workspaceId]: nextRoot };
    });
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

  const project = store.projects.find((p) => p.id === dialog.projectId);
  if (!project) return;
  const name = dialog.name.trim();
  if (!name) return;
  const id = await invoke<string>('new_id');
  const rows = Math.min(5, Math.max(1, Math.floor(dialog.rows || 1)));
  const columns = Math.min(5, Math.max(1, Math.floor(dialog.columns || 1)));
  const terminalIds = Array.from({ length: rows * columns }, (_, index) => `${id}:${index}`);
  const splits = buildGridSplit(terminalIds, rows, columns);
  const workspace: WorkspaceEntry = { id, name, command: dialog.command.trim() || null, cwd: project.path, splits };
  setStore((s) => ({
    projects: s.projects.map((p) => p.id === project.id ? { ...p, collapsed: false, workspaces: [...p.workspaces, workspace] } : p),
  }));
  selectWorkspace(project.id, id);
  setSidebarFocusedWorkspaceId(id);
  setDialog(null);
}
