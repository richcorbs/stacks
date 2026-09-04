import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type React from 'react';
import type { DialogState, Project, Store, TerminalEntry, WorkspaceTemplate } from '../types';
import { basename } from '../utils';
import { newWorkspaceDialog, submitWorkspaceDialog, workspaceDialogFromTemplate } from '../workspace/dialogSubmit';
import type { CreateWorkspace } from '../workspace/createWorkspace';

type WorkspaceDialogCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  dialog: DialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  completeSplitTerminal: (workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null, initialInput?: string, paneKind?: 'terminal' | 'pi') => Promise<void>;
  updateTerminalPane: (workspaceId: string, terminalId: string, paneKind: 'terminal' | 'pi', command: string | null) => Promise<void>;
  createWorkspace: CreateWorkspace;
};

export function useWorkspaceDialogCommands({
  store,
  setStore,
  dialog,
  setDialog,
  selectWorkspace,
  terminalsByWorkspaceId,
  completeSplitTerminal,
  updateTerminalPane,
  createWorkspace,
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
    setDialog(newWorkspaceDialog(project.id, `Workspace ${project.workspaces.length + 1}`));
  }

  function openWorkspaceTemplateDialog(project: Project, template: WorkspaceTemplate) {
    setDialog(workspaceDialogFromTemplate(project.id, template));
  }

  function openEditTerminalDialog(workspaceId: string, terminalId: string) {
    const workspace = store.projects.flatMap((project) => project.workspaces).find((candidate) => candidate.id === workspaceId);
    const terminal = (terminalsByWorkspaceId[workspaceId] ?? []).find((candidate) => candidate.id === terminalId);
    const command = terminal?.command ?? (terminalId === `${workspaceId}:0` ? workspace?.command ?? '' : '');
    setDialog({ kind: 'editTerminal', workspaceId, terminalId, command, paneKind: terminal?.kind === 'pi' ? 'pi' : 'terminal' });
  }

  async function submitDialog() {
    await submitWorkspaceDialog({
      dialog,
      store,
      setStore,
      setDialog,
      completeSplitTerminal,
      updateTerminalPane,
      addProject,
      createWorkspace,
    });
  }

  return {
    openProjectDialog,
    addProjectFromPath,
    openWorkspaceDialog,
    openWorkspaceTemplateDialog,
    openEditTerminalDialog,
    submitDialog,
  };
}
