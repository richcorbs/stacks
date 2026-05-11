import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type React from 'react';
import type { DialogState, Pane, Project, SplitNode, Store, TerminalEntry } from '../types';
import { basename, rebalanceSplits, removeLeaf, normalizeSplitNode, setSplitRatio, splitLeaf } from '../utils';
import { disposePaneSession, disposePaneSessions, isPaneSessionAtBottom, requestPaneSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { paneIdsForTerminal, previousPaneIdAfterClose, shouldMaximizeNewSplit } from '../workspace/selectors';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type WorkspaceCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  dialog: DialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  activeTerminal: TerminalEntry | null;
  activePaneId: string | null;
  maximizedPaneId: string | null;
  sidebarFocusedTerminalId: string | null;
  activeTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  sidebarTerminals: SidebarTerminal[];
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  focusPaneState: (terminalId: string, paneId: string) => void;
  toggleMaximizedPaneState: () => void;
  removeTerminalState: (terminalId: string) => void;
  removeProjectState: (projectId: string, terminalIds: string[]) => void;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActivePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedPaneByTerminalId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMaximizedPaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActivityTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
};

export function useWorkspaceCommands(options: WorkspaceCommandOptions) {
  const {
    store,
    setStore,
    dialog,
    setDialog,
    activeTerminal,
    activePaneId,
    maximizedPaneId,
    panesByTerminalId,
    splitRootsByTerminalId,
    sidebarFocusedTerminalId,
    activeTerminalId,
    sidebarTerminals,
    selectTerminal,
    focusPaneState,
    toggleMaximizedPaneState,
    removeTerminalState,
    removeProjectState,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setActivePaneId,
    setFocusedPaneByTerminalId,
    setMaximizedPaneId,
    setSidebarFocusedTerminalId,
    setRunningPaneIds,
    setActivityTerminalIds,
  } = options;

  function saveTerminalSplit(terminalId: string, root: SplitNode | null) {
    const normalizedRoot = normalizeSplitNode(root);
    setStore((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        terminals: p.terminals.map((t) => t.id === terminalId ? { ...t, splits: normalizedRoot } : t),
      })),
    }));
  }

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
    setDialog({ kind: 'terminal', projectId: project.id, name: `Terminal ${project.terminals.length + 1}`, command: '' });
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
          setDialog({ kind: 'terminal', projectId: project.id, name: 'Terminal 1', command: '' });
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
      setStore((s) => ({
        projects: s.projects.map((p) => p.id === dialog.projectId ? {
          ...p,
          terminals: p.terminals.map((t) => t.id === dialog.terminalId ? { ...t, name, command: dialog.command.trim() || null } : t),
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

  function toggleProject(projectId: string) {
    setStore((s) => ({ projects: s.projects.map((p) => p.id === projectId ? { ...p, collapsed: !p.collapsed } : p) }));
  }

  function openEditProjectDialog(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path });
  }

  function openEditTerminalDialog(project: Project, terminal: TerminalEntry) {
    setDialog({ kind: 'editTerminal', projectId: project.id, terminalId: terminal.id, name: terminal.name, command: terminal.command ?? '' });
  }

  function focusPane(terminalId: string, paneId: string) {
    focusPaneState(terminalId, paneId);
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

  async function completeSplitPane(terminalId: string, focusedPaneId: string, direction: 'row' | 'column', command: string | null) {
    const id = `${terminalId}:${Date.now()}`;
    const existingPaneIds = paneIdsForTerminal(terminalId, panesByTerminalId, splitRootsByTerminalId[terminalId]);
    const shouldMaximizeNewPane = shouldMaximizeNewSplit(terminalId, existingPaneIds, maximizedPaneId);
    setPanesByTerminalId((all) => ({ ...all, [terminalId]: [...(all[terminalId] ?? []), { id, terminalId, command }] }));
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId] ?? { kind: 'leaf' as const, paneId: focusedPaneId };
      const nextRoot = splitLeaf(root, focusedPaneId, id, direction, command);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
    focusPane(terminalId, id);
    requestPaneSessionsScrollToBottomAfterFit([...(panesByTerminalId[terminalId] ?? []).map((pane) => pane.id), id]);
    if (shouldMaximizeNewPane) setMaximizedPaneId(id);
  }

  async function splitPane(direction: 'row' | 'column' = 'row') {
    if (!activeTerminal) return;
    const focusedPaneId = maximizedPaneId?.startsWith(`${activeTerminal.id}:`)
      ? maximizedPaneId
      : activePaneId?.startsWith(`${activeTerminal.id}:`) ? activePaneId : `${activeTerminal.id}:0`;
    setDialog({ kind: 'split', terminalId: activeTerminal.id, targetPaneId: focusedPaneId, direction, command: '' });
  }

  function cyclePane(delta: number) {
    if (!activeTerminal) return;
    const paneIds = paneIdsForTerminal(activeTerminal.id, panesByTerminalId, splitRootsByTerminalId[activeTerminal.id]);
    if (paneIds.length === 0) return;
    const currentPaneId = maximizedPaneId ?? activePaneId;
    const currentIndex = Math.max(0, paneIds.findIndex((id) => id === currentPaneId));
    const nextIndex = (currentIndex + delta + paneIds.length) % paneIds.length;
    const nextPaneId = paneIds[nextIndex];
    focusPane(activeTerminal.id, nextPaneId);
    if (maximizedPaneId) setMaximizedPaneId(nextPaneId);
  }

  function cycleSidebarTerminal(delta: number) {
    if (sidebarTerminals.length === 0) return;
    const currentId = sidebarFocusedTerminalId ?? activeTerminalId;
    const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === currentId));
    const nextIndex = (currentIndex + delta + sidebarTerminals.length) % sidebarTerminals.length;
    setSidebarFocusedTerminalId(sidebarTerminals[nextIndex].terminal.id);
  }

  function activateSidebarFocusedTerminal() {
    if (!sidebarFocusedTerminalId) return;
    const match = sidebarTerminals.find(({ terminal }) => terminal.id === sidebarFocusedTerminalId);
    if (!match) return;
    selectTerminal(match.project.id, match.terminal.id);
    setSidebarFocusedTerminalId(null);
  }

  function activateTerminalByIndex(index: number) {
    const match = sidebarTerminals[index];
    if (!match) return;
    selectTerminal(match.project.id, match.terminal.id);
    setSidebarFocusedTerminalId(null);
  }

  function toggleMaximizedPane() {
    const paneId = activePaneId;
    if (!paneId || !activeTerminalId) return;

    const paneIds = paneIdsForTerminal(activeTerminalId, panesByTerminalId, splitRootsByTerminalId[activeTerminalId]);
    if (paneIds.length <= 1) {
      setMaximizedPaneId(null);
      return;
    }

    const shouldRestoreBottom = isPaneSessionAtBottom(paneId);
    toggleMaximizedPaneState();
    if (shouldRestoreBottom) {
      requestPaneSessionsScrollToBottomAfterFit([paneId]);
    }
  }

  function resizeSplit(terminalId: string, path: string, ratio: number) {
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = setSplitRatio(root, path, ratio);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
    requestPaneSessionsScrollToBottomAfterFit((panesByTerminalId[terminalId] ?? []).map((pane) => pane.id));
  }

  async function closePane(paneId: string) {
    const terminalId = paneId.split(':')[0];
    const currentPanes = panesByTerminalId[terminalId] ?? [];
    const visualPaneIds = paneIdsForTerminal(terminalId, panesByTerminalId, options.splitRootsByTerminalId[terminalId]);

    disposePaneSession(paneId);
    await invoke('kill_pty', { paneId }).catch(() => {});
    setRunningPaneIds((ids) => ids.filter((id) => id !== paneId));

    if (currentPanes.length <= 1) {
      if (maximizedPaneId === paneId) setMaximizedPaneId(null);
      return;
    }

    const remainingPaneIds = visualPaneIds.filter((id) => id !== paneId);
    const nextPaneId = previousPaneIdAfterClose(visualPaneIds, paneId);

    if (remainingPaneIds.length <= 1) setMaximizedPaneId(null);
    else if (maximizedPaneId === paneId) setMaximizedPaneId(nextPaneId);
    setPanesByTerminalId((all) => ({ ...all, [terminalId]: (all[terminalId] ?? []).filter((p) => p.id !== paneId) }));
    if (nextPaneId) focusPane(terminalId, nextPaneId);

    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = rebalanceSplits(removeLeaf(root, paneId), paneId);
      saveTerminalSplit(terminalId, nextRoot);
      return nextRoot ? { ...all, [terminalId]: nextRoot } : all;
    });
    requestPaneSessionsScrollToBottomAfterFit(remainingPaneIds);
  }

  return {
    openProjectDialog,
    addProjectFromPath,
    openTerminalDialog,
    submitDialog,
    toggleProject,
    openEditProjectDialog,
    openEditTerminalDialog,
    focusPane,
    deleteTerminal,
    moveProject,
    moveTerminal,
    deleteProject,
    splitPane,
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedPane,
    resizeSplit,
    closePane,
  };
}
