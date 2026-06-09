import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { DialogState, Pane, Project, Store, TerminalEntry } from '../types';
import { disposePaneSessions } from '../terminalSessionManager';

type WorkspaceCrudCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  panesByTerminalId: Record<string, Pane[]>;
  removeTerminalState: (terminalId: string) => void;
  removeProjectState: (projectId: string, terminalIds: string[]) => void;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActivityTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useWorkspaceCrudCommands({
  store,
  setStore,
  setDialog,
  panesByTerminalId,
  removeTerminalState,
  removeProjectState,
  setRunningPaneIds,
  setActivityTerminalIds,
}: WorkspaceCrudCommandOptions) {
  function toggleProject(projectId: string) {
    setStore((s) => ({ projects: s.projects.map((p) => p.id === projectId ? { ...p, collapsed: !p.collapsed } : p) }));
  }

  function openEditProjectDialog(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path });
  }

  function openEditTerminalDialog(project: Project, terminal: TerminalEntry) {
    setDialog({
      kind: 'editTerminal',
      projectId: project.id,
      terminalId: terminal.id,
      name: terminal.name,
      command: terminal.command ?? '',
      cwd: terminal.cwd || project.path,
    });
  }

  function deleteTerminal(projectId: string, terminalId: string) {
    const paneIds = (panesByTerminalId[terminalId] ?? []).map((pane) => pane.id);
    disposePaneSessions(paneIds);
    paneIds.forEach((paneId) => invoke('kill_pty', { paneId }).catch(() => {}));
    setStore((s) => ({ projects: s.projects.map((p) => p.id === projectId ? { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) } : p) }));
    removeTerminalState(terminalId);
    setRunningPaneIds((ids) => ids.filter((id) => !id.startsWith(`${terminalId}:`)));
    setActivityTerminalIds((ids) => ids.filter((id) => id !== terminalId));
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

  function moveTerminal(projectId: string, draggedTerminalId: string, targetTerminalId: string) {
    if (draggedTerminalId === targetTerminalId) return;
    setStore((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const terminals = [...p.terminals];
        const from = terminals.findIndex((t) => t.id === draggedTerminalId);
        const to = terminals.findIndex((t) => t.id === targetTerminalId);
        if (from < 0 || to < 0) return p;
        const [item] = terminals.splice(from, 1);
        terminals.splice(to, 0, item);
        return { ...p, terminals };
      }),
    }));
  }

  function deleteProject(projectId: string) {
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) return;
    const terminalIds = project.terminals.map((terminal) => terminal.id);
    const paneIds = terminalIds.flatMap((terminalId) => (panesByTerminalId[terminalId] ?? []).map((pane) => pane.id));
    disposePaneSessions(paneIds);
    paneIds.forEach((paneId) => invoke('kill_pty', { paneId }).catch(() => {}));
    setStore((s) => ({ projects: s.projects.filter((p) => p.id !== projectId) }));
    removeProjectState(projectId, terminalIds);
    setRunningPaneIds((ids) => ids.filter((id) => !terminalIds.some((terminalId) => id.startsWith(`${terminalId}:`))));
    setActivityTerminalIds((ids) => ids.filter((id) => !terminalIds.includes(id)));
  }

  return {
    toggleProject,
    openEditProjectDialog,
    openEditTerminalDialog,
    deleteTerminal,
    moveProject,
    moveTerminal,
    deleteProject,
  };
}
