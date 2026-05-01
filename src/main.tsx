import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { ContextMenu, ConfirmClosePaneDialog, Dialog } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { MainWorkspace } from './components/MainWorkspace';
import { disposePaneSession } from './components/TerminalWorkspace';
import type { ContextMenuState, DialogState, PointerDragState, Project, SplitNode, Store, TerminalEntry } from './types';
import { basename, collectLeafPaneIds, loadSidebarWidth, normalizeSplitNode, parseDragData, removeLeaf, setSplitRatio, splitLeaf } from './utils';
import { useAppStats } from './hooks/useAppStats';
import { useDebouncedStoreSave, usePersistentSidebarWidth } from './hooks/useDebouncedSave';
import { useGitInfo } from './hooks/useGitInfo';
import { usePaneActivity } from './hooks/usePaneActivity';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePaneCwd } from './hooks/usePaneCwd';
import { useSidebarInteractions } from './hooks/useSidebarInteractions';

function App() {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const { state: workspace, actions: workspaceActions } = useWorkspaceState();
  const {
    activeProjectId,
    activeTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    visitedTerminalIds,
    activePaneId,
    focusedPaneByTerminalId,
    maximizedPaneId,
    sidebarFocusedTerminalId,
    paneCwds,
  } = workspace;
  const {
    setActiveProjectId,
    setActiveTerminalId,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setVisitedTerminalIds,
    setActivePaneId,
    setFocusedPaneByTerminalId,
    setMaximizedPaneId,
    setSidebarFocusedTerminalId,
    selectTerminal,
    focusPane: focusPaneState,
    toggleMaximizedPane: toggleMaximizedPaneState,
    removeTerminalState,
    removeProjectState,
    rememberPaneCwd,
  } = workspaceActions;
  const [metaKeyDown, setMetaKeyDown] = useState(false);

  const { runningPaneIds, setRunningPaneIds, activityTerminalIds, setActivityTerminalIds } = usePaneActivity(activeTerminalId);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const resizingSidebarRef = useRef(false);
  const justPointerDraggedRef = useRef(false);
  const [confirmClosePaneId, setConfirmClosePaneId] = useState<string | null>(null);

  const activeProject = useMemo(
    () => store.projects.find((p) => p.id === activeProjectId) ?? null,
    [store, activeProjectId]
  );
  const activeTerminal = useMemo(
    () => activeProject?.terminals.find((t) => t.id === activeTerminalId) ?? null,
    [activeProject, activeTerminalId]
  );
  const sidebarTerminals = useMemo(
    () => store.projects.flatMap((project) => project.terminals.map((terminal) => ({ project, terminal }))),
    [store]
  );
  const activePath = (activePaneId && paneCwds[activePaneId]) || activeTerminal?.cwd || activeProject?.path || null;
  const appStats = useAppStats();
  const gitInfo = useGitInfo(activePath);

  useDebouncedStoreSave(loaded, store);
  usePersistentSidebarWidth(sidebarWidth);

  useEffect(() => {
    invoke<Store>('load_store').then((loadedStore) => {
      setStore(loadedStore);
      const firstProject = loadedStore.projects[0];
      if (firstProject) selectTerminal(firstProject.id, null);
      else setActiveProjectId(null);
      setLoaded(true);
    }).catch((err) => {
      console.error(err);
      setLoaded(true);
    });
  }, []);


  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, []);

  useSidebarInteractions({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
  });

  useEffect(() => {
    setSidebarFocusedTerminalId(activeTerminalId);
  }, [activeTerminalId]);

  usePaneCwd(activePaneId, rememberPaneCwd, setStore);


  useEffect(() => {
    if (!activeTerminal) {
      setActivePaneId(null);
      return;
    }

    const paneId = `${activeTerminal.id}:0`;
    const root = normalizeSplitNode(activeTerminal.splits) ?? { kind: 'leaf' as const, paneId };
    const leafIds = collectLeafPaneIds(root);
    const paneIds = leafIds.length > 0 ? leafIds : [paneId];
    setVisitedTerminalIds((ids) => ids.includes(activeTerminal.id) ? ids : [...ids, activeTerminal.id]);
    setPanesByTerminalId((all) => {
      if (all[activeTerminal.id]?.length) return all;
      return { ...all, [activeTerminal.id]: paneIds.map((id) => ({ id, terminalId: activeTerminal.id })) };
    });
    setSplitRootsByTerminalId((all) => {
      if (all[activeTerminal.id]) return all;
      return { ...all, [activeTerminal.id]: root };
    });
    setActivePaneId((id) => {
      if (id?.startsWith(`${activeTerminal.id}:`)) return id;
      const rememberedPaneId = focusedPaneByTerminalId[activeTerminal.id];
      return rememberedPaneId && paneIds.includes(rememberedPaneId) ? rememberedPaneId : paneId;
    });
  }, [activeTerminal?.id, focusedPaneByTerminalId]);

  useKeyboardShortcuts({
    activeProject,
    activePaneId,
    setMetaKeyDown,
    activateTerminalByIndex,
    openTerminalDialog,
    openProjectDialog,
    toggleMaximizedPane,
    activateSidebarFocusedTerminal,
    splitPane,
    requestClosePane: setConfirmClosePaneId,
    cycleSidebarTerminal,
    cyclePane,
  });

  async function openProjectDialog() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Add Project',
    }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected !== 'string') return;
    await addProjectFromPath(selected);
  }

  async function addProjectFromPath(path: string) {
    const existing = store.projects.find((p) => p.path === path);
    if (existing) {
      const terminalId = existing.terminals[0]?.id ?? null;
      selectTerminal(existing.id, terminalId);
      return;
    }
    const id = await invoke<string>('new_id');
    const project: Project = { id, name: basename(path), path, terminals: [], collapsed: false };
    setStore((s) => ({ projects: [...s.projects, project] }));
    selectTerminal(id, null);
  }

  function openTerminalDialog(project: Project) {
    setDialog({ kind: 'terminal', projectId: project.id, name: `Terminal ${project.terminals.length + 1}`, command: '' });
  }

  async function submitDialog() {
    if (!dialog) return;

    if (dialog.kind === 'project') {
      const path = dialog.path.trim();
      if (!path) return;
      await addProjectFromPath(path);
      setDialog(null);
      return;
    }

    if (dialog.kind === 'editProject') {
      const name = dialog.name.trim();
      const path = dialog.path.trim();
      if (!name || !path) return;
      setStore((s) => ({
        projects: s.projects.map((p) => p.id === dialog.projectId ? { ...p, name, path } : p),
      }));
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
    const terminal: TerminalEntry = {
      id,
      name,
      command: dialog.command.trim() || null,
      cwd: project.path,
    };
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === project.id ? { ...p, collapsed: false, terminals: [...p.terminals, terminal] } : p),
    }));
    selectTerminal(project.id, id);
    setDialog(null);
  }

  function toggleProject(projectId: string) {
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? { ...p, collapsed: !p.collapsed } : p),
    }));
  }

  function openEditProjectDialog(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path });
  }

  function openEditTerminalDialog(project: Project, terminal: TerminalEntry) {
    setDialog({ kind: 'editTerminal', projectId: project.id, terminalId: terminal.id, name: terminal.name, command: terminal.command ?? '' });
  }

  function saveTerminalSplit(terminalId: string, root: SplitNode | null) {
    const normalizedRoot = normalizeSplitNode(root);
    setStore((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        terminals: p.terminals.map((t) => t.id === terminalId ? { ...t, splits: normalizedRoot } : t),
      })),
    }));
  }

  function focusPane(terminalId: string, paneId: string) {
    focusPaneState(terminalId, paneId);
  }

  function deleteTerminal(projectId: string, terminalId: string) {
    (panesByTerminalId[terminalId] ?? []).forEach((pane) => {
      disposePaneSession(pane.id);
      invoke('kill_pty', { paneId: pane.id }).catch(() => {});
    });
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) } : p),
    }));
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
    terminalIds.forEach((terminalId) => {
      (panesByTerminalId[terminalId] ?? []).forEach((pane) => {
        disposePaneSession(pane.id);
        invoke('kill_pty', { paneId: pane.id }).catch(() => {});
      });
    });
    setStore((s) => ({ projects: s.projects.filter((p) => p.id !== projectId) }));
    removeProjectState(projectId, terminalIds);
    setRunningPaneIds((ids) => ids.filter((id) => !terminalIds.some((terminalId) => id.startsWith(`${terminalId}:`))));
    setActivityTerminalIds((ids) => ids.filter((id) => !terminalIds.includes(id)));
  }

  async function splitPane(direction: 'row' | 'column' = 'row') {
    if (!activeTerminal) return;
    const focusedPaneId = activePaneId?.startsWith(`${activeTerminal.id}:`) ? activePaneId : `${activeTerminal.id}:0`;
    const id = `${activeTerminal.id}:${Date.now()}`;
    setPanesByTerminalId((all) => ({
      ...all,
      [activeTerminal.id]: [...(all[activeTerminal.id] ?? []), { id, terminalId: activeTerminal.id }],
    }));
    setSplitRootsByTerminalId((all) => {
      const root = all[activeTerminal.id] ?? { kind: 'leaf' as const, paneId: focusedPaneId };
      const nextRoot = splitLeaf(root, focusedPaneId, id, direction);
      saveTerminalSplit(activeTerminal.id, nextRoot);
      return { ...all, [activeTerminal.id]: nextRoot };
    });
    focusPane(activeTerminal.id, id);
  }

  function cyclePane(delta: number) {
    if (!activeTerminal) return;
    const panes = panesByTerminalId[activeTerminal.id] ?? [];
    if (panes.length === 0) return;
    const currentPaneId = maximizedPaneId ?? activePaneId;
    const currentIndex = Math.max(0, panes.findIndex((p) => p.id === currentPaneId));
    const nextIndex = (currentIndex + delta + panes.length) % panes.length;
    const nextPaneId = panes[nextIndex].id;
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
  }

  function activateTerminalByIndex(index: number) {
    const match = sidebarTerminals[index];
    if (!match) return;
    selectTerminal(match.project.id, match.terminal.id);
  }

  function toggleMaximizedPane() {
    toggleMaximizedPaneState();
  }

  function resizeSplit(terminalId: string, path: string, ratio: number) {
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = setSplitRatio(root, path, ratio);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
  }

  async function closePane(paneId: string) {
    disposePaneSession(paneId);
    await invoke('kill_pty', { paneId }).catch(() => {});
    const terminalId = paneId.split(':')[0];
    const remainingPaneCount = (panesByTerminalId[terminalId] ?? []).filter((p) => p.id !== paneId).length;
    if (maximizedPaneId === paneId) setMaximizedPaneId(null);
    setPanesByTerminalId((all) => {
      const nextPanes = (all[terminalId] ?? []).filter((p) => p.id !== paneId);
      if (activePaneId === paneId) {
        const nextPaneId = nextPanes[0]?.id ?? null;
        setActivePaneId(nextPaneId);
        setFocusedPaneByTerminalId((focused) => nextPaneId ? { ...focused, [terminalId]: nextPaneId } : focused);
      }
      return { ...all, [terminalId]: nextPanes };
    });
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      if (remainingPaneCount === 0) {
        saveTerminalSplit(terminalId, null);
        const { [terminalId]: _removed, ...rest } = all;
        return rest;
      }
      const nextRoot = removeLeaf(root, paneId);
      saveTerminalSplit(terminalId, nextRoot);
      return nextRoot ? { ...all, [terminalId]: nextRoot } : all;
    });
  }

  const visitedTerminalWorkspaces = visitedTerminalIds.flatMap((terminalId) => {
    for (const project of store.projects) {
      const terminal = project.terminals.find((t) => t.id === terminalId);
      if (terminal) return [{ project, terminal, panes: panesByTerminalId[terminalId] ?? [], root: splitRootsByTerminalId[terminalId] }];
    }
    return [];
  });

  return (
    <div className="app">
      <Sidebar
        width={sidebarWidth}
        store={store}
        activeProjectId={activeProjectId}
        activeTerminalId={activeTerminalId}
        sidebarFocusedTerminalId={sidebarFocusedTerminalId}
        sidebarTerminals={sidebarTerminals}
        runningPaneIds={runningPaneIds}
        activityTerminalIds={activityTerminalIds}
        metaKeyDown={metaKeyDown}
        appStats={appStats}
        justPointerDraggedRef={justPointerDraggedRef}
        pointerDragRef={pointerDragRef}
        resizingSidebarRef={resizingSidebarRef}
        toggleProject={toggleProject}
        selectTerminal={selectTerminal}
        setContextMenu={setContextMenu}
      />
      <MainWorkspace
        activePath={activePath}
        gitInfo={gitInfo}
        workspaces={visitedTerminalWorkspaces}
        activeTerminalId={activeTerminalId}
        activePaneId={activePaneId}
        maximizedPaneId={maximizedPaneId}
        onResizeSplit={resizeSplit}
        onFocusPane={(projectId, terminalId, paneId) => {
          selectTerminal(projectId, terminalId);
          focusPane(terminalId, paneId);
        }}
        onClosePane={closePane}
      />
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          store={store}
          onClose={() => setContextMenu(null)}
          onEditProject={(project) => { setContextMenu(null); openEditProjectDialog(project); }}
          onDeleteProject={(project) => { setContextMenu(null); deleteProject(project.id); }}
          onEditTerminal={(project, terminal) => { setContextMenu(null); openEditTerminalDialog(project, terminal); }}
          onDeleteTerminal={(project, terminal) => { setContextMenu(null); deleteTerminal(project.id, terminal.id); }}
        />
      )}
      {dialog && <Dialog dialog={dialog} setDialog={setDialog} onCancel={() => setDialog(null)} onSubmit={submitDialog} />}
      {confirmClosePaneId && (
        <ConfirmClosePaneDialog
          onCancel={() => setConfirmClosePaneId(null)}
          onConfirm={() => {
            const paneId = confirmClosePaneId;
            setConfirmClosePaneId(null);
            closePane(paneId);
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
