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
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  completeSplitTerminal: (workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null) => Promise<void>;
};

export function useWorkspaceDialogCommands({
  store,
  setStore,
  dialog,
  setDialog,
  selectWorkspace,
  setSidebarFocusedWorkspaceId,
  completeSplitTerminal,
}: WorkspaceDialogCommandOptions) {
  async function addProject(name: string, path: string) {
    const existing = store.projects.find((p) => p.path === path);
    if (existing) {
      selectWorkspace(existing.id, existing.workspaces[0]?.id ?? null);
      return existing;
    }
    const id = await invoke<string>('new_id');
    const project: Project = { id, name, path, workspaces: [], collapsed: false };
    setStore((s) => ({ projects: [...s.projects, project] }));
    selectWorkspace(id, null);
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
      selectWorkspace(existing.id, existing.workspaces[0]?.id ?? null);
      return;
    }
    setDialog({ kind: 'project', name: basename(selected), path: selected, openTerminalAfterCreate: true });
  }

  function openWorkspaceDialog(project: Project) {
    setDialog({ kind: 'workspace', projectId: project.id, name: `Workspace ${project.workspaces.length + 1}`, command: '' });
  }

  async function submitDialog() {
    await submitWorkspaceDialog({
      dialog,
      store,
      setStore,
      setDialog,
      selectWorkspace,
      setSidebarFocusedWorkspaceId,
      completeSplitTerminal,
      addProject,
    });
  }

  return {
    openProjectDialog,
    addProjectFromPath,
    openWorkspaceDialog,
    submitDialog,
  };
}
