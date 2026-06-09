import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type React from 'react';
import type { DialogState, Project, Store, TerminalEntry } from '../types';
import { basename } from '../utils';

type WorkspaceDialogCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  dialog: DialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  completeSplitPane: (terminalId: string, focusedPaneId: string, direction: 'row' | 'column', command: string | null) => Promise<void>;
};

export function useWorkspaceDialogCommands({
  store,
  setStore,
  dialog,
  setDialog,
  selectTerminal,
  setSidebarFocusedTerminalId,
  completeSplitPane,
}: WorkspaceDialogCommandOptions) {
  async function addProject(name: string, path: string) {
    const existing = store.projects.find((p) => p.path === path);
    if (existing) {
      selectTerminal(existing.id, existing.terminals[0]?.id ?? null);
      return existing;
    }
    const id = await invoke<string>('new_id');
    const project: Project = { id, name, path, terminals: [], collapsed: false };
    setStore((s) => ({ projects: [...s.projects, project] }));
    selectTerminal(id, null);
    return project;
  }

  async function addProjectFromPath(path: string) {
    return addProject(basename(path), path);
  }

  async function openProjectDialog() {
    const selected = await open({ directory: true, multiple: false, title: 'Add Project' }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected !== 'string') return;
    const existing = store.projects.find((p) => p.path === selected);
    if (existing) {
      selectTerminal(existing.id, existing.terminals[0]?.id ?? null);
      return;
    }
    setDialog({ kind: 'project', name: basename(selected), path: selected, openTerminalAfterCreate: true });
  }

  function openTerminalDialog(project: Project) {
    setDialog({ kind: 'terminal', projectId: project.id, name: `Workspace ${project.terminals.length + 1}`, command: '' });
  }

  async function submitDialog() {
    if (!dialog) return;

    if (dialog.kind === 'project') {
      const name = dialog.name.trim();
      const path = dialog.path.trim();
      if (!name || !path) return;
      const project = await addProject(name, path);
      if (dialog.openTerminalAfterCreate) {
        setDialog(null);
        window.setTimeout(() => {
          setDialog({ kind: 'terminal', projectId: project.id, name: 'Workspace 1', command: '' });
        }, 200);
      } else {
        setDialog(null);
      }
      return;
    }

    if (dialog.kind === 'split') {
      await completeSplitPane(dialog.terminalId, dialog.targetPaneId, dialog.direction, dialog.command.trim() || null);
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
      const name = dialog.name.trim();
      if (!name) return;
      const cwd = dialog.cwd.trim() || null;
      setStore((s) => ({
        projects: s.projects.map((p) => p.id === dialog.projectId ? {
          ...p,
          terminals: p.terminals.map((t) => t.id === dialog.terminalId ? { ...t, name, command: dialog.command.trim() || null, cwd } : t),
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
    const terminal: TerminalEntry = { id, name, command: dialog.command.trim() || null, cwd: project.path };
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === project.id ? { ...p, collapsed: false, terminals: [...p.terminals, terminal] } : p),
    }));
    selectTerminal(project.id, id);
    setSidebarFocusedTerminalId(id);
    setDialog(null);
  }

  return {
    openProjectDialog,
    addProjectFromPath,
    openTerminalDialog,
    submitDialog,
  };
}
