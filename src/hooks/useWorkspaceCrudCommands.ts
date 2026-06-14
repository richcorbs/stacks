import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { DialogState, TerminalEntry, Project, Store, WorkspaceEntry } from '../types';
import { disposeTerminalSessions } from '../terminalSessionManager';

type WorkspaceCrudCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  removeTerminalState: (workspaceId: string) => void;
  removeProjectState: (projectId: string, workspaceIds: string[]) => void;
  setRunningTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActivityWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useWorkspaceCrudCommands({
  store,
  setStore,
  setDialog,
  terminalsByWorkspaceId,
  removeTerminalState,
  removeProjectState,
  setRunningTerminalIds,
  setActivityWorkspaceIds,
}: WorkspaceCrudCommandOptions) {
  function toggleProject(projectId: string) {
    setStore((s) => ({ projects: s.projects.map((p) => p.id === projectId ? { ...p, collapsed: !p.collapsed } : p) }));
  }

  function openEditProjectDialog(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path });
  }

  function openEditWorkspaceDialog(project: Project, workspace: WorkspaceEntry) {
    setDialog({
      kind: 'editWorkspace',
      projectId: project.id,
      workspaceId: workspace.id,
      name: workspace.name,
      command: workspace.command ?? '',
      cwd: workspace.cwd || project.path,
    });
  }

  function deleteWorkspace(projectId: string, workspaceId: string) {
    const terminalIds = (terminalsByWorkspaceId[workspaceId] ?? []).map((terminal) => terminal.id);
    disposeTerminalSessions(terminalIds);
    terminalIds.forEach((terminalId) => invoke('kill_pty', { terminalId }).catch(() => {}));
    setStore((s) => ({ projects: s.projects.map((p) => p.id === projectId ? { ...p, workspaces: p.workspaces.filter((workspace) => workspace.id !== workspaceId) } : p) }));
    removeTerminalState(workspaceId);
    setRunningTerminalIds((ids) => ids.filter((id) => !id.startsWith(`${workspaceId}:`)));
    setActivityWorkspaceIds((ids) => ids.filter((id) => id !== workspaceId));
  }

  function moveProject(draggedProjectId: string, targetProjectId: string) {
    if (draggedProjectId === targetProjectId) return;
    setStore((s) => {
      const projects = [...s.projects];
      const from = projects.findIndex((p) => p.id === draggedProjectId);
      const to = projects.findIndex((p) => p.id === targetProjectId);
      if (from < 0 || to < 0) return s;
      const [item] = projects.splice(from, 1);
      projects.splice(to, 0, item);
      return { projects };
    });
  }

  function moveTerminal(projectId: string, draggedWorkspaceId: string, targetWorkspaceId: string) {
    if (draggedWorkspaceId === targetWorkspaceId) return;
    setStore((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const workspaces = [...p.workspaces];
        const from = workspaces.findIndex((t) => t.id === draggedWorkspaceId);
        const to = workspaces.findIndex((t) => t.id === targetWorkspaceId);
        if (from < 0 || to < 0) return p;
        const [item] = workspaces.splice(from, 1);
        workspaces.splice(to, 0, item);
        return { ...p, workspaces };
      }),
    }));
  }

  function deleteProject(projectId: string) {
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) return;
    const workspaceIds = project.workspaces.map((workspace) => workspace.id);
    const terminalIds = workspaceIds.flatMap((workspaceId) => (terminalsByWorkspaceId[workspaceId] ?? []).map((terminal) => terminal.id));
    disposeTerminalSessions(terminalIds);
    terminalIds.forEach((terminalId) => invoke('kill_pty', { terminalId }).catch(() => {}));
    setStore((s) => ({ projects: s.projects.filter((p) => p.id !== projectId) }));
    removeProjectState(projectId, workspaceIds);
    setRunningTerminalIds((ids) => ids.filter((id) => !workspaceIds.some((workspaceId) => id.startsWith(`${workspaceId}:`))));
    setActivityWorkspaceIds((ids) => ids.filter((id) => !workspaceIds.includes(id)));
  }

  return {
    toggleProject,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    deleteWorkspace,
    moveProject,
    moveTerminal,
    deleteProject,
  };
}
