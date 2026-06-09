import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type React from 'react';
import type { DialogState, Project, Store } from '../types';
import { basename } from '../utils';
import { submitWorkspaceDialog } from '../workspace/dialogSubmit';

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
    await submitWorkspaceDialog({
      dialog,
      store,
      setStore,
      setDialog,
      selectTerminal,
      setSidebarFocusedTerminalId,
      completeSplitPane,
      addProject,
    });
  }

  return {
    openProjectDialog,
    addProjectFromPath,
    openTerminalDialog,
    submitDialog,
  };
}
